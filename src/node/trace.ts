/**
 * Observer trace (experiments). An observer node receives a sealed copy of every message in an org that lists it under
 * `observers`, and records the plaintext here instead of acting on it. `agent-network trace export` turns the rows into
 * the event stream described in docs/EXPERIMENT.md.
 */
import type { EnvelopeHeader } from '../../shared/protocol.ts';
import type { Ctx } from '../types.ts';
import { fromJson, iso, toJson } from '../util.ts';

export interface TraceEvent {
  run_id: string | null;
  /** When the sender created the message. */
  t: string;
  actor: string;
  event: 'contact' | 'answer' | 'declined' | 'approved' | 'deferred' | 'publish' | 'manifest' | 'snapshot';
  message_id: string;
  reply_to: string | null;
  component: string | null;
  audience: string[];
  text: string | null;
  meta: Record<string, unknown>;
}

interface TraceRow {
  seq: number;
  id: string;
  created_at: string;
  sender: string;
  audience: string;
  kind: string;
  priority: string;
  reply_to: string | null;
  component_id: string | null;
  payload: string;
}

type Loose = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function recordTrace(ctx: Ctx, header: EnvelopeHeader, payload: unknown): void {
  const component = str((payload as Loose | null)?.component) ?? str((payload as Loose | null)?.component_id);
  ctx.db.run(
    `INSERT OR IGNORE INTO trace (id, created_at, observed_at, sender, audience, kind, priority, reply_to, component_id, payload)
     VALUES (:id, :created, :now, :sender, :audience, :kind, :priority, :replyTo, :component, :payload)`,
    {
      id: header.id,
      created: header.created_at,
      now: iso(ctx.now()),
      sender: header.sender,
      audience: toJson(header.audience),
      kind: header.kind,
      priority: header.priority,
      replyTo: header.reply_to,
      component,
      payload: toJson(payload),
    },
  );
}

function describe(kind: string, priority: string, payload: Loose): Pick<TraceEvent, 'event' | 'text' | 'meta'> {
  switch (kind) {
    case 'enquiry':
      return { event: 'contact', text: str(payload.question), meta: { kind, priority, subject: payload.subject ?? null, agent: payload.agent ?? null, details: payload.details ?? null } };
    case 'answer': {
      const status = str(payload.status);
      return {
        event: status === 'declined' ? 'declined' : 'answer',
        text: str(payload.answer),
        meta: { status, confidence: payload.confidence ?? null, auto: payload.auto ?? null, decided_by_human: payload.decided_by_human ?? false, evidence: payload.evidence ?? [] },
      };
    }
    case 'change_notice':
    case 'implementation_doc':
      return { event: 'contact', text: str(payload.summary), meta: { kind, priority, title: payload.title ?? null, breaking: payload.breaking ?? false, action_required: payload.action_required ?? null } };
    case 'conflict_report':
      return { event: 'contact', text: str(payload.description), meta: { kind, priority, subject: payload.subject ?? null } };
    case 'receipt': {
      const decision = str(payload.decision);
      return { event: decision === 'rejected' ? 'declined' : decision === 'deferred' ? 'deferred' : 'approved', text: str(payload.note), meta: { kind, decision, item: payload.item ?? null } };
    }
    case 'graph_update':
      return {
        event: 'publish',
        text: null,
        meta: { kind, entries: (payload.entries as unknown[] | undefined)?.length ?? 0, settlements: (payload.settlements as unknown[] | undefined)?.length ?? 0 },
      };
    case 'manifest':
      return { event: 'manifest', text: null, meta: { kind, version: payload.version ?? null } };
    default:
      return { event: 'snapshot', text: null, meta: { kind } };
  }
}

export function exportTrace(ctx: Ctx, options: { run?: string | null } = {}): TraceEvent[] {
  const rows = ctx.db.all<TraceRow>('SELECT * FROM trace ORDER BY created_at, seq');
  return rows.map((row) => {
    const payload = fromJson<Loose>(row.payload, {});
    return {
      run_id: options.run ?? null,
      t: row.created_at,
      actor: row.sender,
      ...describe(row.kind, row.priority, payload),
      message_id: row.id,
      reply_to: row.reply_to,
      component: row.component_id,
      audience: fromJson<string[]>(row.audience, []),
    };
  });
}

export const traceToJsonl = (events: TraceEvent[]): string => events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
