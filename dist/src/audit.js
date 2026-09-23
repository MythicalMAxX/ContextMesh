import { fromJson, iso, toJson } from './util.js';
export function actorLabel(identity) {
    const team = identity.teams[0] ?? 'org';
    const where = identity.component ?? identity.repository ?? identity.developer;
    return `${team}/${where}`;
}
export function describeActor(identity) {
    return `${actorLabel(identity)} (${identity.agent}, ${identity.developer})`;
}
/** Append-only record of every cross-agent interaction, for debugging and accountability. */
export function audit(ctx, actor, action, refs = {}) {
    ctx.db.run(`INSERT INTO audit_log (ts, actor, actor_developer, action, subject, request_id, conflict_id, details)
     VALUES (:ts, :actor, :dev, :action, :subject, :request_id, :conflict_id, :details)`, {
        ts: iso(ctx.now()),
        actor: actor ? toJson(actor) : null,
        dev: actor?.developer ?? null,
        action,
        subject: refs.subject ?? null,
        request_id: refs.request_id ?? null,
        conflict_id: refs.conflict_id ?? null,
        details: refs.details === undefined ? null : toJson(refs.details),
    });
}
export function listAudit(ctx, filter = {}) {
    const rows = ctx.db.all(`SELECT * FROM audit_log
     WHERE (:request_id IS NULL OR request_id = :request_id) AND (:developer IS NULL OR actor_developer = :developer)
     ORDER BY id DESC LIMIT :limit`, { request_id: filter.request_id ?? null, developer: filter.developer ?? null, limit: filter.limit ?? 200 });
    return rows.map((row) => ({ ...row, actor: fromJson(row.actor, null), details: fromJson(row.details, null) }));
}
//# sourceMappingURL=audit.js.map