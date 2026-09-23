import { audit, describeActor } from './audit.js';
import { detectConflicts, openConflictsFor, presentConflict } from './conflicts.js';
import { coerceContract, contractFacts, diffContracts } from './contracts.js';
import { invalid, notFound } from './errors.js';
import { addEdge, assertRead, assertWrite, canRead, canWrite, describeOwner, endpointOwner, getComponent, getRepository, listComponents, requireComponent, } from './registry.js';
import { endpointKeysMatch, endpointMatches, isEndpointKey, looksLikeTaskKey, matchScore, parseEndpoint, subjectKey, tokens, } from './subjects.js';
import { AUTHORITATIVE_SOURCES, } from './types.js';
import { ageLabel, fromJson, iso, randomToken, sameCommit, sha256, stableJson, toJson, unique } from './util.js';
export const IMPLEMENTATION_STATUSES = ['planned', 'in_progress', 'complete', 'deprecated'];
export const TEST_STATUSES = ['passing', 'failing', 'none', 'unknown'];
/** Types where a newer publication replaces the older one instead of adding to it. */
const VERSIONED_TYPES = new Set(['api_contract', 'implementation_status', 'dependency', 'schema']);
export function subjectKind(ctx, subject) {
    if (parseEndpoint(subject))
        return 'endpoint';
    if (getComponent(ctx, subject))
        return 'component';
    if (looksLikeTaskKey(subject))
        return 'task';
    return 'topic';
}
export function getEntry(ctx, id) {
    return ctx.db.get('SELECT * FROM context_entries WHERE id = :id', { id });
}
function currentInSlot(ctx, slot) {
    return ctx.db.get("SELECT * FROM context_entries WHERE slot = :slot AND status = 'current'", { slot });
}
function factSubjectsOf(ctx, entryId) {
    return ctx.db
        .all('SELECT DISTINCT subject_key FROM facts WHERE entry_id = :entryId', { entryId })
        .map((r) => r.subject_key);
}
export function upsertEntry(ctx, input) {
    const key = subjectKey(input.subject);
    const facts = (input.facts ?? []).map((fact) => ({
        subject_key: fact.subject ? subjectKey(fact.subject) : key,
        field: fact.field,
        property: fact.property,
        location: fact.location ?? '*',
        value: fact.value,
        source_kind: fact.source ?? input.source_kind,
        evidence: fact.evidence ?? input.source_ref ?? null,
    }));
    const verified = unique(input.verified_against ?? []);
    const contentHash = sha256(stableJson({
        key,
        component: input.component_id,
        type: input.type,
        title: input.title ?? null,
        data: input.data ?? null,
        impl: input.impl_status ?? null,
        tests: input.tests ?? null,
        verified,
        facts,
    }));
    const now = input.generated_at ?? iso(ctx.now());
    const origin = input.origin ?? 'local';
    return ctx.db.tx(() => {
        if (input.id) {
            const existing = getEntry(ctx, input.id);
            if (existing)
                return { entry: existing, previous: null, changed: false, factSubjects: [] };
        }
        const previous = input.slot ? (currentInSlot(ctx, input.slot) ?? null) : null;
        if (previous && origin !== 'local' && previous.generated_at > now) {
            // A newer version already arrived; late deliveries never roll knowledge back.
            return { entry: previous, previous: null, changed: false, factSubjects: [] };
        }
        if (previous && previous.content_hash === contentHash) {
            // Same knowledge re-confirmed: refresh provenance without creating a new version. A new commit on a local
            // entry is shared as a lightweight re-confirmation (shared = 2) so other nodes can judge freshness.
            const commit = input.commit ?? previous.commit_sha;
            const reconfirm = origin === 'local' && previous.shared === 1 && commit !== previous.commit_sha ? 2 : previous.shared;
            ctx.db.run('UPDATE context_entries SET commit_sha = :commit, generated_at = :now, shared = :shared WHERE id = :id', {
                commit,
                now,
                shared: reconfirm,
                id: previous.id,
            });
            return { entry: getEntry(ctx, previous.id), previous, changed: false, factSubjects: [] };
        }
        const id = input.id ?? randomToken('ctx_', 9);
        ctx.db.run(`INSERT INTO context_entries (id, slot, subject, subject_key, subject_kind, component_id, type, title, data, content_hash,
         source_kind, source_ref, commit_sha, generated_at, published_by, verified_against, impl_status, tests, status, supersedes,
         origin, shared)
       VALUES (:id, :slot, :subject, :key, :kind, :component, :type, :title, :data, :hash,
         :source, :ref, :commit, :now, :by, :verified, :impl, :tests, 'current', :supersedes, :origin, :shared)`, {
            id,
            slot: input.slot ?? id,
            subject: input.subject.trim(),
            key,
            kind: subjectKind(ctx, input.subject),
            component: input.component_id,
            type: input.type,
            title: input.title ?? null,
            data: toJson(input.data ?? null),
            hash: contentHash,
            source: input.source_kind,
            ref: input.source_ref ?? null,
            commit: input.commit ?? null,
            now,
            by: input.published_by ? toJson(input.published_by) : null,
            verified: toJson(verified),
            impl: input.impl_status ?? null,
            tests: input.tests ?? null,
            supersedes: previous?.id ?? null,
            origin,
            shared: origin === 'local' ? 0 : 1,
        });
        if (previous) {
            ctx.db.run("UPDATE context_entries SET status = 'superseded' WHERE id = :id", { id: previous.id });
        }
        for (const fact of facts) {
            ctx.db.run(`INSERT INTO facts (entry_id, subject_key, field, property, location, value, source_kind, evidence)
         VALUES (:id, :subject, :field, :property, :location, :value, :source, :evidence)`, {
                id,
                subject: fact.subject_key,
                field: fact.field,
                property: fact.property,
                location: fact.location,
                value: toJson(fact.value),
                source: fact.source_kind,
                evidence: fact.evidence,
            });
        }
        const factSubjects = unique([...facts.map((f) => f.subject_key), ...(previous ? factSubjectsOf(ctx, previous.id) : [])]);
        return { entry: getEntry(ctx, id), previous, changed: true, factSubjects };
    });
}
/** Marks an entry as no longer true (e.g. an endpoint removed from the OpenAPI spec). */
export function retireEntry(ctx, entry) {
    ctx.db.run("UPDATE context_entries SET status = 'retired', generated_at = :now, shared = CASE WHEN origin = 'local' THEN 0 ELSE shared END WHERE id = :id", {
        id: entry.id,
        now: iso(ctx.now()),
    });
    return factSubjectsOf(ctx, entry.id);
}
export function currentEntries(ctx, filter) {
    return ctx.db.all(`SELECT * FROM context_entries WHERE status = 'current'
       AND (:key IS NULL OR subject_key = :key) AND (:component IS NULL OR component_id = :component)
       AND (:type IS NULL OR type = :type) AND (:source IS NULL OR source_kind = :source)
     ORDER BY generated_at DESC`, { key: filter.subjectKey ?? null, component: filter.componentId ?? null, type: filter.type ?? null, source: filter.sourceKind ?? null });
}
// ---------------------------------------------------------------------------
// Provenance, freshness and confidence
// ---------------------------------------------------------------------------
const shortSha = (sha) => sha.slice(0, 8);
export function entryFreshness(ctx, entry) {
    if (entry.commit_sha && entry.component_id) {
        const component = getComponent(ctx, entry.component_id);
        const repo = component?.repository_id ? getRepository(ctx, component.repository_id) : undefined;
        if (repo?.head_commit && repo.indexed_at && !sameCommit(entry.commit_sha, repo.head_commit) && repo.indexed_at > entry.generated_at) {
            return {
                status: 'possibly_stale',
                detail: `generated at commit ${shortSha(entry.commit_sha)}; ${repo.id} is now at ${shortSha(repo.head_commit)}`,
            };
        }
    }
    const age = ctx.now().getTime() - Date.parse(entry.generated_at);
    if (age > ctx.config.freshness.max_age_days * 86_400_000) {
        return { status: 'aging', detail: `generated ${ageLabel(entry.generated_at, ctx.now())} and not re-verified since` };
    }
    return { status: 'fresh' };
}
/** Source kinds an entry vouches for: its own source plus anything the publisher verified it against. */
function evidenceKinds(entry) {
    const kinds = [entry.source_kind, ...fromJson(entry.verified_against, [])];
    if (entry.tests === 'passing')
        kinds.push('tests');
    return kinds;
}
export function assessConfidence(ctx, entries, openConflicts) {
    const fresh = entries.filter((e) => entryFreshness(ctx, e).status === 'fresh');
    const kinds = unique(entries.flatMap(evidenceKinds)).sort();
    const authoritative = unique(fresh.flatMap(evidenceKinds).filter((k) => AUTHORITATIVE_SOURCES.has(k)));
    const reasons = [];
    let level;
    if (authoritative.length >= 2) {
        level = 'high';
        reasons.push(`corroborated by ${authoritative.join(', ')}`);
    }
    else if (authoritative.length === 1) {
        level = 'medium';
        reasons.push(`single authoritative source (${authoritative[0]})`);
    }
    else {
        level = 'low';
        reasons.push(kinds.length ? `only ${kinds.join(', ')} available; implementation not verified` : 'no context published');
    }
    const stale = entries.length - fresh.length;
    if (stale > 0)
        reasons.push(`${stale} source(s) possibly stale`);
    if (openConflicts > 0) {
        if (level === 'high')
            level = 'medium';
        reasons.push(`${openConflicts} open conflict(s)`);
    }
    return { level, evidence: kinds, reasons };
}
function publisherLabel(entry) {
    const identity = fromJson(entry.published_by, null);
    return identity ? describeActor(identity) : null;
}
export function presentEntry(ctx, entry, includeData = true) {
    return {
        id: entry.id,
        type: entry.type,
        subject: entry.subject,
        ...(entry.title ? { summary: entry.title } : {}),
        component: entry.component_id,
        source: entry.source_kind,
        ...(entry.source_ref ? { source_ref: entry.source_ref } : {}),
        commit: entry.commit_sha,
        generated_at: entry.generated_at,
        ...(entry.published_by ? { published_by: publisherLabel(entry) } : {}),
        verified_against: fromJson(entry.verified_against, []),
        ...(entry.impl_status ? { implementation: entry.impl_status } : {}),
        ...(entry.tests ? { tests: entry.tests } : {}),
        freshness: entryFreshness(ctx, entry),
        ...(includeData ? { data: fromJson(entry.data, null) } : {}),
    };
}
function endpointCatalog(ctx) {
    return ctx.db.all(`SELECT subject_key, subject, component_id, title FROM context_entries
     WHERE subject_kind = 'endpoint' AND status = 'current'
     ORDER BY CASE type WHEN 'api_contract' THEN 0 ELSE 1 END, CASE source_kind WHEN 'openapi' THEN 0 ELSE 1 END`);
}
function endpointMatchesFor(ctx, text, ignoreVersion) {
    const ref = parseEndpoint(text);
    const byKey = new Map();
    for (const row of endpointCatalog(ctx)) {
        if (byKey.has(row.subject_key) || !endpointMatches(row.subject_key, ref, { ignoreVersion }))
            continue;
        byKey.set(row.subject_key, {
            kind: 'endpoint',
            key: row.subject_key,
            display: row.subject,
            component_id: endpointOwner(ctx, row.subject)?.component ?? row.component_id,
            via: ignoreVersion ? 'endpoint (version-insensitive match)' : 'endpoint',
        });
    }
    return [...byKey.values()];
}
export function resolveSubject(ctx, identity, query) {
    const text = query.trim();
    if (!text)
        throw invalid('subject must not be empty');
    if (parseEndpoint(text)) {
        let matches = endpointMatchesFor(ctx, text, false);
        if (matches.length === 0)
            matches = endpointMatchesFor(ctx, text, true);
        if (matches.length === 1)
            return { best: matches[0], candidates: [] };
        if (matches.length > 1)
            return { best: null, candidates: matches };
        return {
            best: { kind: 'endpoint', key: subjectKey(text), display: text, component_id: null, via: 'endpoint (nothing indexed or published yet)' },
            candidates: [],
        };
    }
    const component = getComponent(ctx, text);
    if (component)
        return { best: { kind: 'component', key: component.id, display: component.id, component_id: component.id, via: 'component' }, candidates: [] };
    const task = ctx.db.get('SELECT key, component_id FROM tasks WHERE key = :key COLLATE NOCASE', { key: text });
    if (task)
        return { best: { kind: 'task', key: task.key, display: task.key, component_id: task.component_id, via: 'task' }, candidates: [] };
    const topic = ctx.db.get("SELECT subject, component_id FROM context_entries WHERE subject_key = :key AND status = 'current' LIMIT 1", { key: subjectKey(text) });
    if (topic)
        return { best: { kind: 'topic', key: subjectKey(text), display: topic.subject, component_id: topic.component_id, via: 'topic' }, candidates: [] };
    // Lexical search across everything with a name.
    const query_ = tokens(text);
    const scored = [];
    for (const c of listComponents(ctx)) {
        const aliases = ctx.db.all('SELECT alias FROM component_aliases WHERE component_id = :id', { id: c.id }).map((a) => a.alias);
        const score = Math.max(matchScore(query_, tokens([c.id, ...aliases].join(' '))), 0.8 * matchScore(query_, tokens(c.description ?? '')));
        scored.push({ kind: 'component', key: c.id, display: c.id, component_id: c.id, via: 'search', score });
    }
    const seenEndpoints = new Set();
    for (const e of endpointCatalog(ctx)) {
        if (seenEndpoints.has(e.subject_key))
            continue;
        seenEndpoints.add(e.subject_key);
        const score = matchScore(query_, tokens(`${e.subject} ${e.title ?? ''}`));
        scored.push({ kind: 'endpoint', key: e.subject_key, display: e.subject, component_id: e.component_id, via: 'search', score });
    }
    for (const t of ctx.db.all('SELECT key, title, component_id FROM tasks')) {
        scored.push({ kind: 'task', key: t.key, display: t.key, component_id: t.component_id, via: 'search', score: 0.9 * matchScore(query_, tokens(t.title ?? '')) });
    }
    for (const t of ctx.db.all("SELECT DISTINCT subject_key, subject, component_id, title FROM context_entries WHERE status = 'current' AND subject_kind = 'topic'")) {
        scored.push({ kind: 'topic', key: t.subject_key, display: t.subject, component_id: t.component_id, via: 'search', score: matchScore(query_, tokens(`${t.subject} ${t.title ?? ''}`)) });
    }
    const ranked = scored
        .filter((s) => (s.score ?? 0) >= 0.5 && canRead(ctx, identity, s.component_id))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || kindRank(a.kind) - kindRank(b.kind));
    if (ranked.length === 0)
        return { best: null, candidates: [] };
    const [first, second] = ranked;
    const clearWinner = !second || (first.score ?? 0) - (second.score ?? 0) >= 0.2 || kindRank(first.kind) < kindRank(second.kind);
    return clearWinner ? { best: first, candidates: ranked.slice(1, 5) } : { best: null, candidates: ranked.slice(0, 5) };
}
const kindRank = (kind) => ({ endpoint: 0, component: 1, topic: 2, task: 3 })[kind];
// ---------------------------------------------------------------------------
// get_context
// ---------------------------------------------------------------------------
function ownerOf(ctx, componentId) {
    return componentId && getComponent(ctx, componentId) ? describeOwner(ctx, componentId) : null;
}
function consumersOfSubject(ctx, key, ownerComponent) {
    const edges = ctx.db.all("SELECT from_id, to_kind, to_id FROM edges WHERE from_kind = 'component' AND rel = 'consumes'");
    return unique(edges
        .filter((e) => (e.to_kind === 'component' ? e.to_id === ownerComponent : endpointKeysMatch(key, e.to_id) || e.to_id === key))
        .map((e) => e.from_id)
        .filter((id) => id !== ownerComponent));
}
function tasksReferencing(ctx, key) {
    const edges = ctx.db.all("SELECT from_id, to_id FROM edges WHERE from_kind = 'task' AND rel = 'depends-on' AND to_kind = 'subject'");
    const keys = unique(edges.filter((e) => e.to_id === key || endpointKeysMatch(key, e.to_id)).map((e) => e.from_id));
    return keys
        .map((k) => ctx.db.get('SELECT key, title, status, component_id, url FROM tasks WHERE key = :k', { k }))
        .filter((t) => !!t);
}
/** Entries stored under a method-less key ("* /path") also describe every method on that path. */
function entriesForEndpoint(ctx, key) {
    const path = key.slice(key.indexOf(' ') + 1);
    return ctx.db.all(`SELECT * FROM context_entries WHERE status = 'current' AND (subject_key = :key OR subject_key = :wildcard)
     ORDER BY generated_at DESC`, { key, wildcard: `* ${path}` });
}
function implementationOf(entries) {
    const latest = entries.find((e) => e.impl_status);
    return latest
        ? { status: latest.impl_status, tests: latest.tests, commit: latest.commit_sha, published_by: publisherLabel(latest), at: latest.generated_at }
        : null;
}
export function getContext(ctx, identity, input) {
    const { best, candidates } = resolveSubject(ctx, identity, input.subject);
    if (!best) {
        return {
            subject: input.subject,
            found: false,
            message: candidates.length
                ? 'The subject is ambiguous; call get_context again with one of the candidates.'
                : 'Nothing is known about this subject yet. Use find_owner, then request_context to ask the owning agent.',
            candidates: candidates.map((c) => ({ subject: c.display, kind: c.kind, component: c.component_id })),
        };
    }
    assertRead(ctx, identity, best.component_id);
    const also = candidates.length ? { other_matches: candidates.map((c) => ({ subject: c.display, kind: c.kind })) } : {};
    switch (best.kind) {
        case 'endpoint':
            return { ...endpointContext(ctx, identity, best), ...also };
        case 'component':
            return { ...componentContext(ctx, identity, best.key), ...also };
        case 'task':
            return { ...taskContext(ctx, identity, best.key), ...also };
        case 'topic':
            return { ...topicContext(ctx, identity, best), ...also };
    }
}
function endpointContext(ctx, identity, subject) {
    const entries = entriesForEndpoint(ctx, subject.key).filter((e) => canRead(ctx, identity, e.component_id));
    const contracts = entries.filter((e) => e.type === 'api_contract');
    const primary = contracts.find((e) => e.source_kind === 'openapi') ?? contracts[0];
    const ownerComponent = subject.component_id ?? primary?.component_id ?? entries[0]?.component_id ?? null;
    const conflicts = openConflictsFor(ctx, subject.key);
    const implementation = implementationOf(entries);
    const knowledge = entries.filter((e) => !['api_contract', 'answer', 'decision', 'task'].includes(e.type));
    return {
        subject: primary?.subject ?? subject.display,
        kind: 'endpoint',
        found: entries.length > 0,
        resolved_via: subject.via,
        owner: ownerOf(ctx, ownerComponent),
        status: implementation?.status ?? (primary ? 'contract_available' : 'unknown'),
        implementation,
        confidence: assessConfidence(ctx, entries.filter((e) => e.type !== 'task'), conflicts.length),
        contract: primary ? { ...fromJson(primary.data, null), _source: presentEntry(ctx, primary, false) } : null,
        ...(contracts.length > 1
            ? { other_contract_sources: contracts.filter((c) => c !== primary).map((c) => presentEntry(ctx, c)) }
            : {}),
        known_conflicts: conflicts.map((c) => presentConflict(ctx, c)),
        decisions: entries.filter((e) => e.type === 'decision').map((e) => presentEntry(ctx, e)),
        previous_answers: entries.filter((e) => e.type === 'answer').slice(0, 10).map((e) => presentEntry(ctx, e)),
        notes: knowledge.map((e) => presentEntry(ctx, e)),
        consumers: consumersOfSubject(ctx, subject.key, ownerComponent),
        related_tasks: tasksReferencing(ctx, subject.key).filter((t) => canRead(ctx, identity, t.component_id)),
    };
}
function componentContext(ctx, identity, componentId) {
    const entries = currentEntries(ctx, { componentId });
    const endpoints = new Map();
    for (const e of entries.filter((x) => x.subject_kind === 'endpoint' && x.type === 'api_contract')) {
        if (!endpoints.has(e.subject_key)) {
            endpoints.set(e.subject_key, {
                subject: e.subject,
                summary: e.title,
                implementation: implementationOf(entriesForEndpoint(ctx, e.subject_key))?.status ?? null,
            });
        }
    }
    const conflicts = ctx.db.all("SELECT * FROM conflicts WHERE component_id = :componentId AND state IN ('open', 'escalated') ORDER BY created_at DESC", { componentId });
    const dependsOn = ctx.db
        .all("SELECT DISTINCT to_id FROM edges WHERE from_kind = 'component' AND from_id = :componentId AND rel = 'consumes'", { componentId })
        .map((r) => r.to_id);
    const tasks = ctx.db.all('SELECT key, title, status FROM tasks WHERE component_id = :componentId ORDER BY key', { componentId });
    return {
        subject: componentId,
        kind: 'component',
        found: true,
        owner: describeOwner(ctx, componentId),
        endpoints: [...endpoints.values()],
        confidence: assessConfidence(ctx, entries.filter((e) => e.type !== 'task'), conflicts.length),
        notes: entries
            .filter((e) => e.subject_kind !== 'endpoint' && !['task', 'answer'].includes(e.type))
            .map((e) => presentEntry(ctx, e)),
        known_conflicts: conflicts.map((c) => presentConflict(ctx, c)),
        depends_on: dependsOn,
        consumers: consumersOfSubject(ctx, componentId, componentId),
        tasks,
    };
}
function taskContext(ctx, identity, key) {
    const task = ctx.db.get('SELECT * FROM tasks WHERE key = :key', { key });
    const dependsOn = ctx.db
        .all("SELECT DISTINCT to_id FROM edges WHERE from_kind = 'task' AND from_id = :key AND rel = 'depends-on'", { key })
        .map((r) => r.to_id);
    const conflicts = ctx.db.all("SELECT * FROM conflicts WHERE state IN ('open', 'escalated') AND sources LIKE :pattern ORDER BY created_at DESC", { pattern: `%task:${key}%` });
    return {
        subject: key,
        kind: 'task',
        found: true,
        task: {
            key: task.key,
            source: task.source,
            title: task.title,
            status: task.status,
            url: task.url,
            assignee: task.assignee,
            updated_at: task.updated_at,
            description: task.description,
        },
        owner: ownerOf(ctx, task.component_id),
        depends_on: dependsOn,
        known_conflicts: conflicts.filter((c) => canRead(ctx, identity, c.component_id)).map((c) => presentConflict(ctx, c)),
        hint: 'Call get_dependencies for owners, implementation status and contract availability of each dependency.',
    };
}
function topicContext(ctx, identity, subject) {
    const entries = currentEntries(ctx, { subjectKey: subject.key }).filter((e) => canRead(ctx, identity, e.component_id));
    const conflicts = openConflictsFor(ctx, subject.key);
    return {
        subject: subject.display,
        kind: 'topic',
        found: entries.length > 0,
        resolved_via: subject.via,
        owner: ownerOf(ctx, subject.component_id ?? entries[0]?.component_id ?? null),
        confidence: assessConfidence(ctx, entries, conflicts.length),
        entries: entries.map((e) => presentEntry(ctx, e)),
        known_conflicts: conflicts.map((c) => presentConflict(ctx, c)),
    };
}
function defaultComponent(ctx, identity, input) {
    if (input.component)
        return requireComponent(ctx, input.component);
    if (input.type === 'dependency')
        return identity.component ? getComponent(ctx, identity.component) : undefined;
    const owner = endpointOwner(ctx, input.subject)?.component ?? getComponent(ctx, input.subject)?.id;
    if (owner && canWrite(ctx, identity, owner))
        return getComponent(ctx, owner);
    return identity.component ? getComponent(ctx, identity.component) : undefined;
}
export function publishContext(ctx, identity, input) {
    const component = defaultComponent(ctx, identity, input);
    if (!component) {
        throw invalid('Cannot tell which component this context belongs to. Pass "component" (or set the X-Component header).');
    }
    assertWrite(ctx, identity, component.id, 'publish context');
    if (input.status && !IMPLEMENTATION_STATUSES.includes(input.status)) {
        throw invalid(`status must be one of ${IMPLEMENTATION_STATUSES.join(', ')}`);
    }
    if (input.tests && !TEST_STATUSES.includes(input.tests)) {
        throw invalid(`tests must be one of ${TEST_STATUSES.join(', ')}`);
    }
    let subject = input.subject.trim();
    let data = input.data ?? null;
    let facts = [...(input.facts ?? [])];
    const verified = input.verified_against ?? [];
    const factSource = ['code', 'tests', 'openapi'].find((k) => verified.includes(k)) ?? 'agent';
    facts = facts.map((f) => ({ ...f, source: f.source ?? factSource }));
    if (input.type === 'api_contract') {
        const ref = parseEndpoint(subject);
        const contract = coerceContract(data ?? {}, ref?.method ?? null, ref?.path ?? null);
        if (!contract)
            throw invalid('api_contract needs an endpoint subject such as "GET /api/resources/{id}" or data.method and data.path.');
        subject = `${contract.method} ${contract.path}`;
        data = contract;
        facts = [...contractFacts(contract).map((f) => ({ ...f, source: factSource })), ...facts];
    }
    const key = subjectKey(subject);
    let slot;
    if (VERSIONED_TYPES.has(input.type))
        slot = `${input.type}|agent|${key}|${component.id}`;
    else if (input.supersedes) {
        const replaced = getEntry(ctx, input.supersedes);
        if (!replaced || replaced.status !== 'current')
            throw notFound(`No current context entry ${input.supersedes} to supersede.`);
        assertWrite(ctx, identity, replaced.component_id, 'supersede context');
        slot = replaced.slot;
    }
    return ctx.db.tx(() => {
        const result = upsertEntry(ctx, {
            subject,
            component_id: component.id,
            type: input.type,
            title: input.summary ?? null,
            data,
            source_kind: 'agent',
            source_ref: identity.repository ? `${identity.repository}${input.commit ? `@${input.commit}` : ''}` : null,
            commit: input.commit ?? null,
            published_by: identity,
            verified_against: verified,
            impl_status: input.status ?? null,
            tests: input.tests ?? null,
            slot,
            facts,
        });
        for (const dependency of input.depends_on ?? []) {
            const target = getComponent(ctx, dependency);
            addEdge(ctx, 'component', component.id, 'consumes', target ? 'component' : 'subject', target ? target.id : subjectKey(dependency), 'agent');
        }
        let contractChange;
        if (input.type === 'api_contract' && result.previous && result.changed) {
            const before = fromJson(result.previous.data, null);
            const changes = before ? diffContracts(before, data) : [];
            if (changes.length) {
                contractChange = { key, changes };
            }
        }
        const conflicts = result.factSubjects.length ? detectConflicts(ctx, result.factSubjects, identity) : [];
        audit(ctx, identity, 'context.published', {
            subject: key,
            details: { entry: result.entry.id, type: input.type, component: component.id, changed: result.changed, conflicts: conflicts.map((c) => c.id) },
        });
        return {
            entry_id: result.entry.id,
            subject,
            component: component.id,
            result: !result.changed ? 'unchanged' : result.previous ? 'updated' : 'created',
            superseded: result.changed ? (result.previous?.id ?? null) : null,
            facts_recorded: facts.length,
            conflicts: conflicts.map((c) => presentConflict(ctx, c)),
            ...(contractChange ? { contract_change: contractChange } : {}),
        };
    });
}
/** Stores an agent's answer as reusable context so the next agent doesn't have to ask again. */
export function recordAnswer(ctx, identity, request, answer, sourceKind = 'agent') {
    const { entry } = upsertEntry(ctx, {
        subject: request.subject ?? request.question,
        component_id: request.target_component,
        type: sourceKind === 'human' ? 'decision' : 'answer',
        title: request.question,
        data: { question: request.question, answer: answer.text, evidence: answer.evidence, confidence: answer.confidence, request_id: request.id },
        source_kind: sourceKind,
        source_ref: request.id,
        commit: answer.commit ?? null,
        published_by: identity,
        verified_against: answer.verified_against,
    });
    return entry.id;
}
export function isEndpointSubject(key) {
    return !!key && isEndpointKey(key);
}
//# sourceMappingURL=context.js.map