import { fromJson, iso, toJson } from '../util.js';
const str = (value) => (typeof value === 'string' ? value : null);
export function recordTrace(ctx, header, payload) {
    const component = str(payload?.component) ?? str(payload?.component_id);
    ctx.db.run(`INSERT OR IGNORE INTO trace (id, created_at, observed_at, sender, audience, kind, priority, reply_to, component_id, payload)
     VALUES (:id, :created, :now, :sender, :audience, :kind, :priority, :replyTo, :component, :payload)`, {
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
    });
}
function describe(kind, priority, payload) {
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
                meta: { kind, entries: payload.entries?.length ?? 0, settlements: payload.settlements?.length ?? 0 },
            };
        case 'manifest':
            return { event: 'manifest', text: null, meta: { kind, version: payload.version ?? null } };
        default:
            return { event: 'snapshot', text: null, meta: { kind } };
    }
}
export function exportTrace(ctx, options = {}) {
    const rows = ctx.db.all('SELECT * FROM trace ORDER BY created_at, seq');
    return rows.map((row) => {
        const payload = fromJson(row.payload, {});
        return {
            run_id: options.run ?? null,
            t: row.created_at,
            actor: row.sender,
            ...describe(row.kind, row.priority, payload),
            message_id: row.id,
            reply_to: row.reply_to,
            component: row.component_id,
            audience: fromJson(row.audience, []),
        };
    });
}
export const traceToJsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
//# sourceMappingURL=trace.js.map