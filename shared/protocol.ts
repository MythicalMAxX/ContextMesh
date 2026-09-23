/**
 * Wire protocol between local nodes and the hub. The hub only ever sees `EnvelopeHeader` metadata;
 * payloads are end-to-end encrypted and signed by the sender.
 */
import { canonicalJson, sha256, toB64u, utf8 } from './crypto.ts';

export const PROTOCOL_VERSION = 1;

export const PRIORITIES = ['urgent', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

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
] as const;
export type Kind = (typeof KINDS)[number];

export const TTL_HOURS: Record<Priority, number> = { urgent: 24, normal: 24 * 14, low: 24 * 30 };
export const MAX_ENVELOPE_BYTES = 512 * 1024;
export const MAX_AUDIENCE = 500;
export const AUTH_WINDOW_MS = 5 * 60_000;
export const ORG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const MEMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface EnvelopeHeader {
  v: 1;
  id: string;
  org: string;
  sender: string;
  audience: string[];
  kind: Kind;
  priority: Priority;
  /** ISO timestamps. */
  created_at: string;
  expires_at: string;
  reply_to: string | null;
}

export interface Envelope {
  header: EnvelopeHeader;
  /** Content key sealed for each recipient (and the sender), keyed by member id. */
  keys: Record<string, string>;
  nonce: string;
  ct: string;
}

/** What is inside `ct`: the payload plus the sender's signature over header and payload. */
export interface SignedPayload {
  payload: unknown;
  sig: string;
}

export interface MemberCert {
  v: 1;
  org: string;
  developer: string;
  name: string | null;
  sign_pub: string;
  box_pub: string;
  roles: string[];
  issued_at: string;
  issuer: string;
}

export interface InviteRecord {
  v: 1;
  org: string;
  id: string;
  developer: string;
  invite_pub: string;
  expires_at: string;
  issuer: string;
}

export interface JoinRequest {
  v: 1;
  org: string;
  invite_id: string;
  developer: string;
  name: string | null;
  sign_pub: string;
  box_pub: string;
}

export interface Revocation {
  v: 1;
  org: string;
  developer: string;
  revoked_at: string;
  issuer: string;
}

export interface DirectoryEntry {
  id: string;
  status: 'pending' | 'active' | 'revoked';
  sign_pub: string;
  box_pub: string;
  cert: MemberCert | null;
  cert_sig: string | null;
  revocation: Revocation | null;
  revocation_sig: string | null;
}

/** Data covered by the sender's inner signature. */
export const signedContent = (header: EnvelopeHeader, payload: unknown) => ({ header, payload });

/** Context bound into each content-key wrap, so wraps cannot be replayed onto other messages or members. */
export const sealContext = (header: EnvelopeHeader, member: string) => `${header.org}:${header.id}:${member}`;

export const aadFor = (header: EnvelopeHeader): Uint8Array => utf8(canonicalJson(header));

// ---------------------------------------------------------------------------
// Request authentication: every hub call is signed with the member's Ed25519 key.
// ---------------------------------------------------------------------------

export async function bodyHash(body: string): Promise<string> {
  return toB64u(await sha256(utf8(body)));
}

export function authString(method: string, pathAndQuery: string, ts: number, nonce: string, hash: string): string {
  return ['AN1', method.toUpperCase(), pathAndQuery, String(ts), nonce, hash].join('\n');
}

export function parseAuthorization(value: string | null): { member: string; ts: number; nonce: string; sig: string } | null {
  if (!value?.startsWith('AN1 ')) return null;
  const fields = Object.fromEntries(
    value
      .slice(4)
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((kv) => kv.length === 2) as [string, string][],
  );
  const ts = Number(fields.ts);
  if (!fields.member || !fields.nonce || !fields.sig || !Number.isFinite(ts)) return null;
  return { member: fields.member, ts, nonce: fields.nonce, sig: fields.sig };
}

/** Structural validation shared by hub and nodes. Returns an error message or null. */
export function validateHeader(header: EnvelopeHeader, org: string, now: number): string | null {
  if (!header || header.v !== 1) return 'unsupported envelope version';
  if (header.org !== org) return 'envelope org mismatch';
  if (!MESSAGE_ID_RE.test(header.id)) return 'invalid message id';
  if (!MEMBER_RE.test(header.sender)) return 'invalid sender';
  if (!Array.isArray(header.audience) || header.audience.length === 0 || header.audience.length > MAX_AUDIENCE) return 'invalid audience';
  if (header.audience.some((m) => typeof m !== 'string' || !MEMBER_RE.test(m))) return 'invalid audience member';
  if (!(KINDS as readonly string[]).includes(header.kind)) return 'invalid kind';
  if (!(PRIORITIES as readonly string[]).includes(header.priority)) return 'invalid priority';
  const created = Date.parse(header.created_at);
  const expires = Date.parse(header.expires_at);
  if (!Number.isFinite(created) || Math.abs(created - now) > 10 * 60_000) return 'created_at outside the allowed clock skew';
  if (!Number.isFinite(expires) || expires <= now || expires - created > TTL_HOURS[header.priority] * 3_600_000 + 60_000) {
    return `expires_at must be in the future and within ${TTL_HOURS[header.priority]}h for ${header.priority} messages`;
  }
  if (header.reply_to !== null && (typeof header.reply_to !== 'string' || !MESSAGE_ID_RE.test(header.reply_to))) return 'invalid reply_to';
  return null;
}
