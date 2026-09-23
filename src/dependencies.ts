import { openConflictsFor } from './conflicts.ts';
import { assessConfidence, currentEntries, entryFreshness, resolveSubject, type EntryRow } from './context.ts';
import { invalid } from './errors.ts';
import { extractEndpoints } from './extract.ts';
import { canRead, describeOwner, endpointOwner, getComponent, listComponents } from './registry.ts';
import { endpointKey, endpointKeysMatch, isEndpointKey, matchScore, tokens } from './subjects.ts';
import type { Ctx, Identity } from './types.ts';
import { unique } from './util.ts';

interface Dependency {
  subject: string;
  kind: 'endpoint' | 'component';
  found_via: string;
  owner: { component: string; owner_team: string; owners: string[]; agents_online: number } | null;
  status: string;
  contract: 'available' | 'missing';
  freshness: string | null;
  confidence: string | null;
  open_conflicts: string[];
}

/** Components that depend on an endpoint: declared dependencies, agent-published dependencies and tasks. */
export function consumersOf(ctx: Ctx, key: string, ownerComponent: string): string[] {
  const componentEdges = ctx.db.all<{ from_id: string; to_kind: string; to_id: string }>(
    "SELECT from_id, to_kind, to_id FROM edges WHERE from_kind = 'component' AND rel = 'consumes'",
  );
  const viaComponents = componentEdges
    .filter((e) => (e.to_kind === 'component' ? e.to_id === ownerComponent : e.to_id === key || endpointKeysMatch(key, e.to_id)))
    .map((e) => e.from_id);
  const taskEdges = ctx.db.all<{ from_id: string; to_id: string }>(
    "SELECT from_id, to_id FROM edges WHERE from_kind = 'task' AND rel = 'depends-on' AND to_kind = 'subject'",
  );
  const viaTasks = taskEdges
    .filter((e) => endpointKeysMatch(key, e.to_id))
    .map((e) => ctx.db.get<{ component_id: string | null }>('SELECT component_id FROM tasks WHERE key = :key', { key: e.from_id })?.component_id)
    .filter((c): c is string => !!c);
  return unique([...viaComponents, ...viaTasks]).filter((c) => c !== ownerComponent && getComponent(ctx, c));
}

function endpointEntries(ctx: Ctx, key: string): EntryRow[] {
  return ctx.db
    .all<EntryRow>("SELECT * FROM context_entries WHERE status = 'current' AND subject_kind = 'endpoint' ORDER BY generated_at DESC")
    .filter((e) => e.subject_key === key || endpointKeysMatch(key, e.subject_key));
}

function describeDependency(ctx: Ctx, identity: Identity, subject: string, foundVia: string): Dependency | null {
  if (isEndpointKey(subject) || /^[A-Z]+ \//.test(subject)) {
    const owner = endpointOwner(ctx, subject);
    const key = owner?.key ?? subject;
    const entries = endpointEntries(ctx, key);
    if (owner && !canRead(ctx, identity, owner.component)) return null;
    const contract = entries.find((e) => e.type === 'api_contract');
    const implementation = entries.find((e) => e.impl_status);
    const conflicts = openConflictsFor(ctx, key);
    const info = owner ? describeOwner(ctx, owner.component) : null;
    return {
      subject: contract?.subject ?? subject,
      kind: 'endpoint',
      found_via: foundVia,
      owner: info ? { component: info.component, owner_team: info.owner_team, owners: info.owners.map((o) => o.id), agents_online: info.agents_online.length } : null,
      status: implementation?.impl_status ?? (contract ? 'contract_available' : 'unknown'),
      contract: contract ? 'available' : 'missing',
      freshness: contract ? entryFreshness(ctx, contract).status : null,
      confidence: entries.length ? assessConfidence(ctx, entries, conflicts.length).level : null,
      open_conflicts: conflicts.map((c) => c.id),
    };
  }
  const component = getComponent(ctx, subject);
  if (!component || !canRead(ctx, identity, component.id)) return null;
  const info = describeOwner(ctx, component.id);
  const contracts = currentEntries(ctx, { componentId: component.id, type: 'api_contract' });
  return {
    subject: component.id,
    kind: 'component',
    found_via: foundVia,
    owner: { component: info.component, owner_team: info.owner_team, owners: info.owners.map((o) => o.id), agents_online: info.agents_online.length },
    status: contracts.length ? `${contracts.length} endpoint(s) documented` : 'unknown',
    contract: contracts.length ? 'available' : 'missing',
    freshness: null,
    confidence: null,
    open_conflicts: [],
  };
}

/**
 * What a task or component depends on, who owns each dependency and whether it is ready to build against.
 * Also returns dependents (who consumes this component) so owners can assess the impact of changes.
 */
export function getDependencies(ctx: Ctx, identity: Identity, input: { task?: string; component?: string; subject?: string }) {
  const found = new Map<string, string>();
  const note = (subject: string, via: string) => {
    if (!found.has(subject)) found.set(subject, via);
  };
  let about: Record<string, unknown>;
  let dependents: string[] = [];

  if (input.task) {
    const task = ctx.db.get<{ key: string; title: string | null; description: string | null; component_id: string | null; status: string | null }>(
      'SELECT key, title, description, component_id, status FROM tasks WHERE key = :key COLLATE NOCASE',
      { key: input.task.trim() },
    );
    const text = task ? `${task.title ?? ''}\n${task.description ?? ''}` : input.task;
    about = task
      ? { task: task.key, title: task.title, status: task.status, component: task.component_id }
      : { task: input.task, note: 'Not an indexed task; dependencies were inferred from the text.' };
    for (const edge of ctx.db.all<{ to_id: string; source: string }>(
      "SELECT to_id, source FROM edges WHERE from_kind = 'task' AND from_id = :key AND rel = 'depends-on'",
      { key: task?.key ?? '' },
    )) {
      note(edge.to_id, edge.source === 'task-text' ? 'mentioned in task' : `declared by ${edge.source}`);
    }
    for (const ref of extractEndpoints(text)) note(endpointKey(ref.method!, ref.path), 'mentioned in task');
    const words = tokens(text);
    for (const component of listComponents(ctx)) {
      if (component.id === task?.component_id) continue;
      if (new RegExp(`\\b${component.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) note(component.id, 'mentioned in task');
    }
    if (found.size === 0) {
      // Nothing explicit: fall back to lexical similarity with documented endpoints.
      const candidates = ctx.db.all<{ subject: string; subject_key: string; title: string | null }>(
        "SELECT DISTINCT subject, subject_key, title FROM context_entries WHERE status = 'current' AND type = 'api_contract'",
      );
      for (const c of candidates) {
        if (matchScore(words, tokens(`${c.subject} ${c.title ?? ''}`)) >= 0.4) note(c.subject_key, 'inferred from task text (verify)');
      }
    }
  } else if (input.component || input.subject) {
    const text = (input.component ?? input.subject)!;
    const { best } = resolveSubject(ctx, identity, text);
    if (!best) throw invalid(`Nothing matches "${text}".`);
    if (best.kind === 'component') {
      about = { component: best.key };
      for (const edge of ctx.db.all<{ to_id: string; source: string }>(
        "SELECT to_id, source FROM edges WHERE from_kind = 'component' AND from_id = :id AND rel = 'consumes'",
        { id: best.key },
      )) {
        note(edge.to_id, `declared (${edge.source})`);
      }
      for (const task of ctx.db.all<{ key: string }>('SELECT key FROM tasks WHERE component_id = :id', { id: best.key })) {
        for (const edge of ctx.db.all<{ to_id: string }>(
          "SELECT to_id FROM edges WHERE from_kind = 'task' AND from_id = :key AND rel = 'depends-on'",
          { key: task.key },
        )) {
          note(edge.to_id, `task ${task.key}`);
        }
      }
      dependents = unique(
        ctx.db
          .all<{ from_id: string; to_kind: string; to_id: string }>("SELECT from_id, to_kind, to_id FROM edges WHERE from_kind = 'component' AND rel = 'consumes'")
          .filter((e) => (e.to_kind === 'component' ? e.to_id === best.key : endpointOwner(ctx, e.to_id)?.component === best.key))
          .map((e) => e.from_id)
          .filter((id) => id !== best.key),
      );
    } else {
      about = { subject: best.display, kind: best.kind };
      note(best.key, 'requested subject');
    }
  } else {
    throw invalid('Pass one of "task", "component" or "subject".');
  }

  const dependencies = [...found.entries()]
    .map(([subject, via]) => describeDependency(ctx, identity, subject, via))
    .filter((d): d is Dependency => d !== null);
  const blocked = dependencies.filter((d) => d.contract === 'missing' || d.open_conflicts.length > 0 || d.status === 'in_progress' || d.status === 'planned');
  return {
    ...about,
    depends_on: dependencies,
    ...(dependents.length ? { dependents } : {}),
    ready: blocked.length === 0,
    ...(blocked.length
      ? { attention: blocked.map((d) => `${d.subject}: ${d.contract === 'missing' ? 'no contract published' : d.open_conflicts.length ? `open conflicts ${d.open_conflicts.join(', ')}` : `implementation ${d.status}`}`) }
      : {}),
  };
}
