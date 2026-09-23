import { fingerprint, verifyJson } from '../../shared/crypto.js';
import { fromJson, iso, toJson } from '../util.js';
/**
 * Pulls the member directory from the hub and keeps only entries whose certificates chain to the pinned org root.
 * The hub cannot add a member, swap a member's keys, or impersonate the root: it can only withhold entries.
 */
export async function refreshDirectory(ctx, hub, keys) {
    const entries = await hub.directory();
    const rootEntry = entries.find((e) => e.id === keys.root.id);
    if (!rootEntry || rootEntry.sign_pub !== keys.root.sign_pub) {
        throw new Error('The hub returned a root key that does not match the pinned org root. Refusing to trust this directory.');
    }
    const members = [];
    const rejected = [];
    for (const entry of entries) {
        if (entry.status === 'pending')
            continue;
        const member = await verifyEntry(entry, keys);
        if (member)
            members.push(member);
        else
            rejected.push(entry.id);
    }
    const now = iso(ctx.now());
    ctx.db.tx(() => {
        ctx.db.run('DELETE FROM members');
        for (const m of members) {
            ctx.db.run(`INSERT INTO members (id, name, status, sign_pub, box_pub, roles, fingerprint, verified_at)
         VALUES (:id, :name, :status, :sign, :box, :roles, :fp, :now)`, { id: m.id, name: m.name, status: m.status, sign: m.sign_pub, box: m.box_pub, roles: toJson(m.roles), fp: m.fingerprint, now });
        }
        ctx.db.run("INSERT INTO node_state (key, value) VALUES ('directory_at', :now) ON CONFLICT(key) DO UPDATE SET value = excluded.value", { now });
    });
    if (rejected.length)
        ctx.log(`directory: rejected unverifiable entries: ${rejected.join(', ')}`);
    return { members, rejected };
}
async function verifyEntry(entry, keys) {
    const cert = entry.cert;
    if (!cert || !entry.cert_sig)
        return null;
    const expectedIssuer = keys.root.id;
    const certOk = cert.v === 1 &&
        cert.org === keys.org &&
        cert.developer === entry.id &&
        cert.sign_pub === entry.sign_pub &&
        cert.box_pub === entry.box_pub &&
        cert.issuer === expectedIssuer &&
        (await verifyJson(keys.root.sign_pub, cert, entry.cert_sig));
    if (!certOk)
        return null;
    let status = 'active';
    if (entry.status === 'revoked') {
        // Revocations are root-signed too; an unsigned "revoked" status is still honored (fail safe: stop sending to them).
        status = 'revoked';
    }
    if (entry.revocation && entry.revocation_sig && (await verifyJson(keys.root.sign_pub, entry.revocation, entry.revocation_sig)))
        status = 'revoked';
    return {
        id: entry.id,
        name: cert.name,
        status,
        sign_pub: cert.sign_pub,
        box_pub: cert.box_pub,
        roles: cert.roles ?? [],
        fingerprint: await fingerprint(cert.sign_pub),
    };
}
export function getMember(ctx, id) {
    const row = ctx.db.get('SELECT * FROM members WHERE id = :id', { id });
    return row ? { ...row, roles: fromJson(row.roles, []) } : undefined;
}
export function activeMembers(ctx) {
    return ctx.db
        .all("SELECT * FROM members WHERE status = 'active' ORDER BY id")
        .map((row) => ({ ...row, roles: fromJson(row.roles, []) }));
}
//# sourceMappingURL=directory.js.map