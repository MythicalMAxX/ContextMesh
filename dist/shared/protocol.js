/**
 * Wire protocol between local nodes and the hub. The hub only ever sees `EnvelopeHeader` metadata;
 * payloads are end-to-end encrypted and signed by the sender.
 */
import { canonicalJson, sha256, toB64u, utf8 } from './crypto.js';
export const PROTOCOL_VERSION = 1;
export const PRIORITIES = ['urgent', 'normal', 'low'];
/**
 * - enquiry / answer:        agent-to-agent questions (urgent ones may be answered automatically, no approval)
 * - conflict_report:         sources disagree; routed to the owner
 * - change_notice:           "I changed X, you may need to adapt" (queued for the recipient developer's approval)
 * - implementation_doc:      "feature X is implemented, here is how to use it" (queued for approval)
 * - graph_update:            shared memory updates (contracts, status, decisions) applied by policy
 * - receipt:                 outcome of a queued item at the recipient (approved / rejected / done)
 * - manifest:                org ownership model, signed by the org root
 * - snapshot:                current graph state for a newly admitted member
 */
export const KINDS = [
    'enquiry',
    'answer',
    'conflict_report',
    'change_notice',
    'implementation_doc',
    'graph_update',
    'receipt',
    'manifest',
    'snapshot',
];
export const TTL_HOURS = { urgent: 24, normal: 24 * 14, low: 24 * 30 };
export const MAX_ENVELOPE_BYTES = 512 * 1024;
export const MAX_AUDIENCE = 500;
export const AUTH_WINDOW_MS = 5 * 60_000;
export const ORG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const MEMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Data covered by the sender's inner signature. */
export const signedContent = (header, payload) => ({ header, payload });
/** Context bound into each content-key wrap, so wraps cannot be replayed onto other messages or members. */
export const sealContext = (header, member) => `${header.org}:${header.id}:${member}`;
export const aadFor = (header) => utf8(canonicalJson(header));
// ---------------------------------------------------------------------------
// Request authentication: every hub call is signed with the member's Ed25519 key.
// ---------------------------------------------------------------------------
export async function bodyHash(body) {
    return toB64u(await sha256(utf8(body)));
}
export function authString(method, pathAndQuery, ts, nonce, hash) {
    return ['AN1', method.toUpperCase(), pathAndQuery, String(ts), nonce, hash].join('\n');
}
export function parseAuthorization(value) {
    if (!value?.startsWith('AN1 '))
        return null;
    const fields = Object.fromEntries(value
        .slice(4)
        .split(',')
        .map((part) => part.trim().split('='))
        .filter((kv) => kv.length === 2));
    const ts = Number(fields.ts);
    if (!fields.member || !fields.nonce || !fields.sig || !Number.isFinite(ts))
        return null;
    return { member: fields.member, ts, nonce: fields.nonce, sig: fields.sig };
}
/** Structural validation shared by hub and nodes. Returns an error message or null. */
export function validateHeader(header, org, now) {
    if (!header || header.v !== 1)
        return 'unsupported envelope version';
    if (header.org !== org)
        return 'envelope org mismatch';
    if (!MESSAGE_ID_RE.test(header.id))
        return 'invalid message id';
    if (!MEMBER_RE.test(header.sender))
        return 'invalid sender';
    if (!Array.isArray(header.audience) || header.audience.length === 0 || header.audience.length > MAX_AUDIENCE)
        return 'invalid audience';
    if (header.audience.some((m) => typeof m !== 'string' || !MEMBER_RE.test(m)))
        return 'invalid audience member';
    if (!KINDS.includes(header.kind))
        return 'invalid kind';
    if (!PRIORITIES.includes(header.priority))
        return 'invalid priority';
    const created = Date.parse(header.created_at);
    const expires = Date.parse(header.expires_at);
    if (!Number.isFinite(created) || Math.abs(created - now) > 10 * 60_000)
        return 'created_at outside the allowed clock skew';
    if (!Number.isFinite(expires) || expires <= now || expires - created > TTL_HOURS[header.priority] * 3_600_000 + 60_000) {
        return `expires_at must be in the future and within ${TTL_HOURS[header.priority]}h for ${header.priority} messages`;
    }
    if (header.reply_to !== null && (typeof header.reply_to !== 'string' || !MESSAGE_ID_RE.test(header.reply_to)))
        return 'invalid reply_to';
    return null;
}
//# sourceMappingURL=protocol.js.map