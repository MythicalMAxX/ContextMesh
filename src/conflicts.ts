import { audit, describeActor } from './audit.ts';
import { recordAnswer } from './context.ts';
import { describeFactValue, normalizeFactValue } from './contracts.ts';
import { conflict as conflictError, notFound } from './errors.ts';
import { assertWrite, endpointOwner } from './registry.ts';
import { endpointKeysMatch, isEndpointKey, subjectKey } from './subjects.ts';
import { AUTHORITATIVE_SOURCES, type ConfidenceLevel, type Ctx, type FactProperty, type Identity } from './types.ts';
import { fromJson, iso, sha256, toJson, unique } from './util.ts';

export interface ConflictRow {
  id: string;
  subject: string;
  subject_key: string;
  field: string | null;
  property: string | null;
  location: string | null;
  description: string;
  sources: string;
  confidence: ConfidenceLevel;
  component_id: string | null;
  state: 'open' | 'escalated' | 'resolved';
  fingerprint: string | null;
  origin: 'detected' | 'reported';
  reported_by: string | null;
  request_id: string | null;
  escalation_id: string | null;
  resolution: string | null;
  resolved_value: string | null;
  follow_up: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ConflictSource {
  source: string;
  value: unknown;
  ref?: string | null;
  component?: string | null;
}

export function getConflict(ctx: Ctx, id: string): ConflictRow {
  const row = ctx.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = :id COLLATE NOCASE', { id });
  if (!row) throw notFound(`No conflict ${id}.`);
  return row;
}

export function openConflictsFor(ctx: Ctx, key: string): ConflictRow[] {
  const rows = ctx.db.all<ConflictRow>("SELECT * FROM conflicts WHERE state IN ('open', 'escalated') ORDER BY created_at DESC");
  return rows.filter((c) => c.subject_key === key || (isEndpointKey(key) && endpointKeysMatch(key, c.subject_key)));
}

export function presentConflict(ctx: Ctx, c: ConflictRow) {
  return {
    id: c.id,
    state: c.state,
    subject: c.subject,
    ...(c.field ? { field: c.field, property: c.property, location: c.location } : {}),
    description: c.description,
    sources: fromJson<ConflictSource[]>(c.sources, []),
    confidence: c.confidence,
    owner: c.component_id,
    origin: c.origin,
    request_id: c.request_id,
    ...(c.escalation_id ? { escalation_id: c.escalation_id } : {}),
    ...(c.resolution
      ? {
          resolution: c.resolution,
          resolved_value: fromJson(c.resolved_value, null),
          follow_up: fromJson<string[]>(c.follow_up, []),
          resolved_by: c.resolved_by,
          resolved_at: c.resolved_at,
        }
      : {}),
    created_at: c.created_at,
  };
}

// ---------------------------------------------------------------------------
// Automatic detection from facts
// ---------------------------------------------------------------------------

interface FactRow {
  field: string;
  property: FactProperty;
  location: string;
  value: string;
  source_kind: string;
  evidence: string | null;
  component_id: string | null;
  source_ref: string | null;
  entry_type: string;
  entry_subject: string;
}

function sourceLabel(fact: FactRow): string {
  if (fact.entry_type === 'task') return `task:${fact.source_ref ?? '?'}`;
  if (fact.source_kind === 'openapi') return `openapi:${fact.source_ref ?? '?'}`;
  return fact.component_id ? `${fact.source_kind} (${fact.component_id})` : fact.source_kind;
}

function describeDisagreement(field: string, location: string, property: FactProperty, groups: Map<string, FactRow[]>): string {
  const parts = [...groups.values()].map((facts) => {
    const value = describeFactValue(property, fromJson(facts[0]!.value, null));
    return `${value} according to ${unique(facts.map(sourceLabel)).join(', ')}`;
  });
  const where = location === '*' ? '' : ` (${location})`;
  return `\`${field}\`${where} ${property}: ${parts.join('; ')}`;
}

function conflictConfidence(sources: string[]): ConfidenceLevel {
  return sources.some((s) => AUTHORITATIVE_SOURCES.has(s)) ? 'high' : 'medium';
}

/**
 * Compares all current facts about the given subjects and opens, updates or closes conflicts.
 * A disagreement already settled (same set of competing values) is not reopened.
 */
export function detectConflicts(ctx: Ctx, subjectKeys: string[], actor: Identity): ConflictRow[] {
  const touched: ConflictRow[] = [];
  for (const key of unique(subjectKeys)) {
    const facts = ctx.db.all<FactRow>(
      `SELECT f.field, f.property, f.location, f.value, f.source_kind, f.evidence,
              e.component_id, e.source_ref, e.type AS entry_type, e.subject AS entry_subject
       FROM facts f JOIN context_entries e ON e.id = f.entry_id
       WHERE f.subject_key = :key AND e.status = 'current'`,
      { key },
    );
    const display = facts.find((f) => f.entry_type === 'api_contract')?.entry_subject ?? key;
    const byFieldProperty = new Map<string, FactRow[]>();
    for (const fact of facts) {
      const group = `${fact.field}\u0000${fact.property}`;
      byFieldProperty.set(group, [...(byFieldProperty.get(group) ?? []), fact]);
    }

    for (const group of byFieldProperty.values()) {
      const { field, property } = group[0]!;
      // Prose rarely says "request" or "response": attach location-less claims to the request side when
      // the field exists there (inputs are what task descriptions usually talk about), else the response.
      const concrete = new Set(group.filter((f) => f.location !== '*').map((f) => f.location));
      const wildcardTarget = concrete.has('request') ? 'request' : concrete.has('response') ? 'response' : '*';
      const buckets = new Map<string, FactRow[]>();
      for (const fact of group) {
        const location = fact.location === '*' ? wildcardTarget : fact.location;
        buckets.set(location, [...(buckets.get(location) ?? []), fact]);
      }
      for (const [location, bucket] of buckets) {
        const byValue = new Map<string, FactRow[]>();
        for (const fact of bucket) {
          const normalized = normalizeFactValue(property, fromJson(fact.value, null));
          byValue.set(normalized, [...(byValue.get(normalized) ?? []), fact]);
        }
        const existing = ctx.db.get<ConflictRow>(
          `SELECT * FROM conflicts WHERE subject_key = :key AND field = :field AND property = :property AND location = :location
             AND state IN ('open', 'escalated')`,
          { key, field, property, location },
        );
        if (byValue.size <= 1) {
          if (existing && existing.origin === 'detected' && existing.state === 'open' && bucket.length > 0) {
            const value = describeFactValue(property, fromJson(bucket[0]!.value, null));
            touched.push(settleBySources(ctx, existing, `All sources now agree: ${value}.`, actor));
          }
          continue;
        }
        const recorded = recordDetected(ctx, actor, { key, display, field, property, location, byValue, existing });
        if (recorded) touched.push(recorded);
      }
    }
  }
  return touched;
}

function recordDetected(
  ctx: Ctx,
  actor: Identity,
  p: { key: string; display: string; field: string; property: FactProperty; location: string; byValue: Map<string, FactRow[]>; existing: ConflictRow | undefined },
): ConflictRow | null {
  const all = [...p.byValue.values()].flat();
  const sources: ConflictSource[] = all.map((f) => ({
    source: f.source_kind,
    value: fromJson(f.value, null),
    ref: f.entry_type === 'task' ? `task:${f.source_ref}` : (f.evidence ?? f.source_ref),
    component: f.component_id,
  }));
  // Every node derives the same fingerprint from the same facts, so settlements can be shared across nodes.
  const fingerprint = sha256(`${p.key}|${p.field}|${p.property}|${p.location}|${[...p.byValue.keys()].sort().join('||')}`);
  const description = describeDisagreement(p.field, p.location, p.property, p.byValue);
  const now = iso(ctx.now());

  if (p.existing) {
    ctx.db.run(
      'UPDATE conflicts SET sources = :sources, fingerprint = :fingerprint, description = :description, updated_at = :now WHERE id = :id',
      { sources: toJson(sources), fingerprint, description, now, id: p.existing.id },
    );
    return getConflict(ctx, p.existing.id);
  }
  // The same disagreement was already settled (e.g. the task is known to be outdated): don't reopen it.
  if (ctx.db.get("SELECT id FROM conflicts WHERE fingerprint = :fingerprint AND state = 'resolved'", { fingerprint })) return null;

  const owner =
    all.find((f) => AUTHORITATIVE_SOURCES.has(f.source_kind) && f.component_id)?.component_id ??
    endpointOwner(ctx, p.display)?.component ??
    all.find((f) => f.component_id)?.component_id ??
    null;
  const id = ctx.db.nextId('CONF');
  ctx.db.run(
    `INSERT INTO conflicts (id, subject, subject_key, field, property, location, description, sources, confidence, component_id,
       state, fingerprint, origin, reported_by, created_at, updated_at)
     VALUES (:id, :subject, :key, :field, :property, :location, :description, :sources, :confidence, :owner,
       'open', :fingerprint, 'detected', :reporter, :now, :now)`,
    {
      id,
      subject: p.display,
      key: p.key,
      field: p.field,
      property: p.property,
      location: p.location,
      description,
      sources: toJson(sources),
      confidence: conflictConfidence(all.map((f) => f.source_kind)),
      owner,
      fingerprint,
      reporter: toJson(actor),
      now,
    },
  );
  audit(ctx, actor, 'conflict.detected', { subject: p.key, conflict_id: id, details: { description, owner } });
  return getConflict(ctx, id);
}

function settleBySources(ctx: Ctx, conflict: ConflictRow, resolution: string, actor: Identity): ConflictRow {
  const now = iso(ctx.now());
  ctx.db.run(
    "UPDATE conflicts SET state = 'resolved', resolution = :resolution, resolved_by = :by, resolved_at = :now, updated_at = :now WHERE id = :id",
    { resolution, by: 'sources converged', now, id: conflict.id },
  );
  audit(ctx, actor, 'conflict.auto_resolved', { subject: conflict.subject_key, conflict_id: conflict.id });
  return getConflict(ctx, conflict.id);
}

// ---------------------------------------------------------------------------
// Conflicts reported by other agents (arrive as messages at the owner's node)
// ---------------------------------------------------------------------------

export interface ConflictReport {
  subject: string;
  field?: string;
  property?: string;
  location?: string;
  description: string;
  sources: ConflictSource[];
  confidence?: ConfidenceLevel;
  component: string;
}

/** Records a reported conflict locally. The message id doubles as the conflict's network-wide id. */
export function recordReportedConflict(ctx: Ctx, messageId: string, reporter: Identity, report: ConflictReport): ConflictRow {
  const existing = ctx.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = :id', { id: messageId });
  if (existing) return existing;
  const now = iso(ctx.now());
  ctx.db.run(
    `INSERT INTO conflicts (id, subject, subject_key, field, property, location, description, sources, confidence, component_id,
       state, origin, reported_by, request_id, created_at, updated_at)
     VALUES (:id, :subject, :key, :field, :property, :location, :description, :sources, :confidence, :owner,
       'open', 'reported', :reporter, :id, :now, :now)`,
    {
      id: messageId,
      subject: report.subject,
      key: subjectKey(report.subject),
      field: report.field ?? null,
      property: report.property ?? null,
      location: report.location ?? null,
      description: report.description,
      sources: toJson(report.sources),
      confidence: report.confidence ?? conflictConfidence(report.sources.map((s) => s.source)),
      owner: report.component,
      reporter: toJson(reporter),
      now,
    },
  );
  audit(ctx, reporter, 'conflict.reported', { subject: subjectKey(report.subject), conflict_id: messageId });
  return getConflict(ctx, messageId);
}

// ---------------------------------------------------------------------------
// Settlements: how a conflict was resolved, shared with every node that can see the component
// ---------------------------------------------------------------------------

export interface Settlement {
  /** Fingerprint for detected conflicts (identical on every node), or null for reported ones. */
  fingerprint: string | null;
  /** The report's message id for reported conflicts, otherwise the fingerprint. */
  conflict_ref: string;
  component: string | null;
  subject: string;
  field: string | null;
  property: string | null;
  location: string | null;
  resolution: string;
  correct_value?: unknown;
  outdated_sources?: string[];
  follow_up?: string[];
  decided_by: 'agent' | 'human';
}

/** Records the settled answer on the conflict and in the subject's context. */
export function markConflictResolved(
  ctx: Ctx,
  conflict: ConflictRow,
  settlement: { resolution: string; correct_value?: unknown; outdated_sources?: string[]; follow_up?: string[]; by: Identity; human: boolean },
): void {
  const now = iso(ctx.now());
  ctx.db.run(
    `UPDATE conflicts SET state = 'resolved', resolution = :resolution, resolved_value = :value, follow_up = :followUp,
       resolved_by = :by, resolved_at = :now, updated_at = :now WHERE id = :id`,
    {
      resolution: settlement.resolution,
      value: settlement.correct_value === undefined ? null : toJson(settlement.correct_value),
      followUp: toJson(settlement.follow_up ?? []),
      by: describeActor(settlement.by),
      now,
      id: conflict.id,
    },
  );
  recordAnswer(
    ctx,
    settlement.by,
    { id: conflict.request_id ?? conflict.id, subject: conflict.subject, question: `Conflict: ${conflict.description}`, target_component: conflict.component_id },
    {
      text: settlement.resolution,
      evidence: [
        ...(settlement.outdated_sources ?? []).map((s) => `outdated: ${s}`),
        ...(settlement.follow_up ?? []).map((s) => `follow-up: ${s}`),
      ],
      confidence: 'high',
      verified_against: [],
    },
    settlement.human ? 'human' : 'agent',
  );
}

export function settlementFor(
  conflict: ConflictRow,
  input: { resolution: string; correct_value?: unknown; outdated_sources?: string[]; follow_up?: string[] },
  human: boolean,
): Settlement {
  return {
    fingerprint: conflict.fingerprint,
    conflict_ref: conflict.origin === 'reported' ? conflict.id : (conflict.fingerprint ?? conflict.id),
    component: conflict.component_id,
    subject: conflict.subject,
    field: conflict.field,
    property: conflict.property,
    location: conflict.location,
    resolution: input.resolution,
    correct_value: input.correct_value,
    outdated_sources: input.outdated_sources,
    follow_up: input.follow_up,
    decided_by: human ? 'human' : 'agent',
  };
}

/** Applies a settlement received from the owning team. Unknown conflicts are remembered so they never open here. */
export function applySettlement(ctx: Ctx, settlement: Settlement, by: Identity): ConflictRow {
  const existing = settlement.fingerprint
    ? ctx.db.get<ConflictRow>('SELECT * FROM conflicts WHERE fingerprint = :fingerprint ORDER BY created_at DESC', { fingerprint: settlement.fingerprint })
    : ctx.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = :id', { id: settlement.conflict_ref });
  const human = settlement.decided_by === 'human';
  if (existing) {
    if (existing.state !== 'resolved') markConflictResolved(ctx, existing, { ...settlement, by, human });
    return getConflict(ctx, existing.id);
  }
  const now = iso(ctx.now());
  const id = settlement.fingerprint ? ctx.db.nextId('CONF') : settlement.conflict_ref;
  ctx.db.run(
    `INSERT INTO conflicts (id, subject, subject_key, field, property, location, description, sources, confidence, component_id,
       state, fingerprint, origin, resolution, resolved_value, follow_up, resolved_by, created_at, updated_at, resolved_at)
     VALUES (:id, :subject, :key, :field, :property, :location, :description, '[]', 'high', :component,
       'resolved', :fingerprint, 'settled', :resolution, :value, :followUp, :by, :now, :now, :now)`,
    {
      id,
      subject: settlement.subject,
      key: subjectKey(settlement.subject),
      field: settlement.field,
      property: settlement.property,
      location: settlement.location,
      description: `Settled by ${describeActor(by)}`,
      component: settlement.component,
      fingerprint: settlement.fingerprint,
      resolution: settlement.resolution,
      value: settlement.correct_value === undefined ? null : toJson(settlement.correct_value),
      followUp: toJson(settlement.follow_up ?? []),
      by: describeActor(by),
      now,
    },
  );
  return getConflict(ctx, id);
}

export interface ResolveConflictInput {
  conflict_id: string;
  resolution: string;
  correct_value?: unknown;
  outdated_sources?: string[];
  follow_up?: string[];
}

/** The owning side settles a conflict. Returns the settlement to share with the org. */
export function resolveConflict(ctx: Ctx, identity: Identity, input: ResolveConflictInput, human = false) {
  const conflict = getConflict(ctx, input.conflict_id);
  if (conflict.state === 'resolved') throw conflictError(`${conflict.id} is already resolved: ${conflict.resolution}`);
  if (conflict.state === 'escalated' && !human) {
    throw conflictError(`${conflict.id} is waiting for your developer's decision; agents cannot settle it.`);
  }
  assertWrite(ctx, identity, conflict.component_id, 'resolve conflicts');
  return ctx.db.tx(() => {
    markConflictResolved(ctx, conflict, { ...input, by: identity, human });
    audit(ctx, identity, 'conflict.resolved', {
      subject: conflict.subject_key,
      conflict_id: conflict.id,
      details: { resolution: input.resolution, follow_up: input.follow_up ?? [] },
    });
    return { conflict: getConflict(ctx, conflict.id), settlement: settlementFor(conflict, input, human) };
  });
}

export function escalateConflict(ctx: Ctx, conflictId: string): void {
  ctx.db.run("UPDATE conflicts SET state = 'escalated', updated_at = :now WHERE id = :id AND state = 'open'", { now: iso(ctx.now()), id: conflictId });
}
