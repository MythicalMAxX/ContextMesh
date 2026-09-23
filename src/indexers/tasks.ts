import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { resolveFrom, type TaskSourceConfig } from '../config.ts';
import { detectConflicts } from '../conflicts.ts';
import { upsertEntry } from '../context.ts';
import { extractEndpoints, extractTaskFacts } from '../extract.ts';
import { addEdge, endpointOwner, getComponent } from '../registry.ts';
import { endpointKey } from '../subjects.ts';
import { SYSTEM_IDENTITY, type Ctx, type FactInput } from '../types.ts';
import { iso, toJson, unique } from '../util.ts';

export interface TaskRecord {
  key: string;
  source: string;
  title: string | null;
  description: string | null;
  status: string | null;
  url: string | null;
  component_id: string | null;
  assignee: string | null;
  labels: string[];
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function loadFileTasks(ctx: Ctx, source: Extract<TaskSourceConfig, { type: 'file' }>): TaskRecord[] {
  const raw = parseYaml(readFileSync(resolveFrom(ctx.config, source.path), 'utf8'));
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
  return list
    .filter((t) => t && typeof t.key === 'string')
    .map((t) => ({
      key: String(t.key).toUpperCase(),
      source: `file:${source.path}`,
      title: t.title ?? null,
      description: t.description ?? null,
      status: t.status ?? null,
      url: t.url ?? null,
      component_id: t.component ? (getComponent(ctx, String(t.component))?.id ?? null) : null,
      assignee: t.assignee ?? null,
      labels: Array.isArray(t.labels) ? t.labels.map(String) : [],
      updated_at: t.updated_at ?? null,
    }));
}

/** Flattens Atlassian Document Format into plain text. */
export function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'inlineCard') return node.attrs?.url ?? '';
  const inner = (node.content ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow'].includes(node.type) ? `${inner}\n` : inner;
}

function developerByEmail(ctx: Ctx, email: string | null | undefined): string | null {
  if (!email) return null;
  return ctx.db.get<{ id: string }>('SELECT id FROM developers WHERE email = :email COLLATE NOCASE', { email })?.id ?? email;
}

async function loadJiraTasks(ctx: Ctx, source: Extract<TaskSourceConfig, { type: 'jira' }>, fetchImpl: typeof fetch): Promise<TaskRecord[]> {
  const email = process.env[source.email_env];
  const token = process.env[source.token_env];
  if (!email || !token) throw new Error(`set ${source.email_env} and ${source.token_env} to index Jira`);
  const base = source.base_url.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const tasks: TaskRecord[] = [];
  let nextPageToken: string | undefined;
  do {
    const response = await fetchImpl(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        jql: source.jql,
        maxResults: 100,
        fields: ['summary', 'description', 'status', 'components', 'labels', 'assignee', 'updated'],
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Jira search failed: HTTP ${response.status} ${await response.text()}`);
    const page = (await response.json()) as { issues?: any[]; nextPageToken?: string; isLast?: boolean };
    for (const issue of page.issues ?? []) {
      const f = issue.fields ?? {};
      const componentNames: string[] = (f.components ?? []).map((c: any) => String(c.name));
      const component = componentNames.map((n) => source.component_map[n] ?? getComponent(ctx, n)?.id).find(Boolean) ?? null;
      tasks.push({
        key: issue.key,
        source: 'jira',
        title: f.summary ?? null,
        description: typeof f.description === 'string' ? f.description : adfToText(f.description).trim() || null,
        status: f.status?.name ?? null,
        url: `${base}/browse/${issue.key}`,
        component_id: component,
        assignee: developerByEmail(ctx, f.assignee?.emailAddress) ?? f.assignee?.displayName ?? null,
        labels: f.labels ?? [],
        updated_at: f.updated ?? null,
      });
    }
    nextPageToken = page.isLast === false || (page.nextPageToken && page.isLast !== true) ? page.nextPageToken : undefined;
  } while (nextPageToken && tasks.length < source.max_results);
  return tasks;
}

const LINEAR_QUERY = `query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes { identifier title description url updatedAt state { name } team { key } labels { nodes { name } } assignee { email name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function loadLinearTasks(ctx: Ctx, source: Extract<TaskSourceConfig, { type: 'linear' }>, fetchImpl: typeof fetch): Promise<TaskRecord[]> {
  const token = process.env[source.token_env];
  if (!token) throw new Error(`set ${source.token_env} to index Linear`);
  const tasks: TaskRecord[] = [];
  let after: string | null = null;
  do {
    const response = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: LINEAR_QUERY,
        variables: { first: 100, after, filter: source.team_keys.length ? { team: { key: { in: source.team_keys } } } : undefined },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Linear query failed: HTTP ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { data?: { issues: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }; errors?: any[] };
    if (body.errors?.length) throw new Error(`Linear query failed: ${body.errors.map((e) => e.message).join('; ')}`);
    const issues = body.data!.issues;
    for (const issue of issues.nodes) {
      const teamKey: string | undefined = issue.team?.key;
      tasks.push({
        key: issue.identifier,
        source: 'linear',
        title: issue.title ?? null,
        description: issue.description ?? null,
        status: issue.state?.name ?? null,
        url: issue.url ?? null,
        component_id: teamKey ? (source.team_map[teamKey] ?? getComponent(ctx, teamKey)?.id ?? null) : null,
        assignee: developerByEmail(ctx, issue.assignee?.email) ?? issue.assignee?.name ?? null,
        labels: (issue.labels?.nodes ?? []).map((l: any) => String(l.name)),
        updated_at: issue.updatedAt ?? null,
      });
    }
    after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  } while (after && tasks.length < source.max_results);
  return tasks;
}

// ---------------------------------------------------------------------------
// Storage: tasks become context entries, dependency edges and comparable facts
// ---------------------------------------------------------------------------

/** Picks the endpoint a prose claim is about: the mentioned endpoint whose contract has that field. */
function subjectForFact(ctx: Ctx, fact: FactInput, endpointKeys: string[], fallback: string): string {
  for (const key of endpointKeys) {
    const known = ctx.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM facts f JOIN context_entries e ON e.id = f.entry_id
       WHERE f.subject_key = :key AND f.field = :field AND e.status = 'current' AND e.type = 'api_contract'`,
      { key, field: fact.field },
    );
    if (known && known.n > 0) return key;
  }
  return endpointKeys.length === 1 ? endpointKeys[0]! : fallback;
}

export function storeTasks(ctx: Ctx, records: TaskRecord[], options: { pruneSource?: string; origin?: string } = {}): { stored: number; conflicts: string[] } {
  const origin = options.origin ?? 'local';
  const now = iso(ctx.now());
  const factSubjects: string[] = [];
  return ctx.db.tx(() => {
    for (const task of records) {
      ctx.db.run(
        `INSERT INTO tasks (key, source, title, description, status, url, component_id, assignee, labels, updated_at, indexed_at, origin, shared)
         VALUES (:key, :source, :title, :description, :status, :url, :component, :assignee, :labels, :updated, :now, :origin, :shared)
         ON CONFLICT(key) DO UPDATE SET source = excluded.source, title = excluded.title, description = excluded.description,
           status = excluded.status, url = excluded.url, component_id = excluded.component_id, assignee = excluded.assignee,
           labels = excluded.labels, updated_at = excluded.updated_at, indexed_at = excluded.indexed_at, origin = excluded.origin,
           shared = CASE WHEN excluded.origin = 'local' AND (tasks.title IS NOT excluded.title OR tasks.description IS NOT excluded.description
             OR tasks.status IS NOT excluded.status OR tasks.component_id IS NOT excluded.component_id OR tasks.origin != 'local') THEN 0
             ELSE CASE WHEN excluded.origin = 'local' THEN tasks.shared ELSE 1 END END`,
        {
          key: task.key,
          source: task.source,
          title: task.title,
          description: task.description,
          status: task.status,
          url: task.url,
          component: task.component_id,
          assignee: task.assignee,
          labels: toJson(task.labels),
          updated: task.updated_at,
          now,
          origin,
          shared: origin === 'local' ? 0 : 1,
        },
      );

      // Dependencies mentioned in the task: the task's component consumes those endpoints.
      ctx.db.run("DELETE FROM edges WHERE (from_kind = 'task' AND from_id = :key) OR source = :source", { key: task.key, source: `task:${task.key}` });
      const text = `${task.title ?? ''}\n${task.description ?? ''}`;
      const endpointKeys = unique(
        extractEndpoints(text).map((ref) => endpointOwner(ctx, `${ref.method} ${ref.path}`)?.key ?? endpointKey(ref.method!, ref.path)),
      );
      for (const key of endpointKeys) {
        addEdge(ctx, 'task', task.key, 'depends-on', 'subject', key, 'task-text');
        if (task.component_id) addEdge(ctx, 'component', task.component_id, 'consumes', 'subject', key, `task:${task.key}`);
      }
      if (task.component_id) addEdge(ctx, 'task', task.key, 'belongs-to', 'component', task.component_id, 'task-text');

      const facts = extractTaskFacts(task.description ?? '').map((fact) => ({
        ...fact,
        subject: subjectForFact(ctx, fact, endpointKeys, task.key),
        evidence: `${task.key}: ${fact.evidence ?? ''}`,
      }));
      const result = upsertEntry(ctx, {
        subject: task.key,
        component_id: task.component_id,
        type: 'task',
        title: task.title,
        data: { key: task.key, title: task.title, status: task.status, url: task.url, assignee: task.assignee, description: task.description },
        source_kind: 'task',
        source_ref: task.key,
        slot: `task|${task.key}`,
        facts,
        origin,
      });
      factSubjects.push(...result.factSubjects);
    }

    if (options.pruneSource) {
      const keep = records.map((r) => r.key);
      const removed = ctx.db.all<{ key: string }>(
        "SELECT key FROM tasks WHERE source = :source AND origin = 'local' AND key NOT IN (SELECT value FROM json_each(:keep))",
        { source: options.pruneSource, keep: toJson(keep) },
      );
      for (const { key } of removed) {
        ctx.db.run('DELETE FROM tasks WHERE key = :key', { key });
        ctx.db.run("DELETE FROM edges WHERE (from_kind = 'task' AND from_id = :key) OR source = :source", { key, source: `task:${key}` });
        const entry = ctx.db.get<{ id: string }>("SELECT id FROM context_entries WHERE slot = :slot AND status = 'current'", { slot: `task|${key}` });
        if (entry) {
          ctx.db.run("UPDATE context_entries SET status = 'retired' WHERE id = :id", { id: entry.id });
          factSubjects.push(
            ...ctx.db.all<{ subject_key: string }>('SELECT DISTINCT subject_key FROM facts WHERE entry_id = :id', { id: entry.id }).map((r) => r.subject_key),
          );
        }
      }
    }

    const conflicts = detectConflicts(ctx, unique(factSubjects), { ...SYSTEM_IDENTITY, agent: 'task-indexer' });
    return { stored: records.length, conflicts: conflicts.filter((c) => c.state !== 'resolved').map((c) => c.id) };
  });
}

export interface TaskIndexReport {
  source: string;
  tasks: number;
  conflicts: string[];
  error?: string;
}

export async function indexTasks(ctx: Ctx, fetchImpl: typeof fetch = fetch): Promise<TaskIndexReport[]> {
  const reports: TaskIndexReport[] = [];
  for (const source of ctx.config.tasks) {
    const label = source.type === 'file' ? `file:${source.path}` : source.type === 'jira' ? `jira:${source.base_url}` : 'linear';
    try {
      const records =
        source.type === 'file'
          ? loadFileTasks(ctx, source)
          : source.type === 'jira'
            ? await loadJiraTasks(ctx, source, fetchImpl)
            : await loadLinearTasks(ctx, source, fetchImpl);
      const { stored, conflicts } = storeTasks(ctx, records, source.type === 'file' ? { pruneSource: `file:${source.path}` } : {});
      reports.push({ source: label, tasks: stored, conflicts });
    } catch (error) {
      reports.push({ source: label, tasks: 0, conflicts: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return reports;
}
