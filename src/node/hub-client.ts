import { randomId, sign, utf8 } from '../../shared/crypto.ts';
import {
  authString,
  bodyHash,
  type DirectoryEntry,
  type Envelope,
  type InviteRecord,
  type JoinRequest,
  type MemberCert,
  type Revocation,
} from '../../shared/protocol.ts';

export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface PostResult {
  seq: number;
  id: string;
  /** Recipients with a live connection right now. */
  online: string[];
}

/** HTTPS client for the hub. Every authenticated call is signed with the member's Ed25519 key. */
export class HubClient {
  readonly baseUrl: string;
  readonly org: string;
  private readonly auth: { member: string; signPrivate: string } | null;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, org: string, auth: { member: string; signPrivate: string } | null, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.org = org;
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, options: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; signed?: boolean } = {}): Promise<T> {
    const query = options.query ? new URLSearchParams(options.query).toString() : '';
    const pathAndQuery = query ? `${path}?${query}` : path;
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
    if (body) headers['content-type'] = 'application/json';
    if (options.signed !== false && this.auth) {
      const ts = Date.now();
      const nonce = randomId();
      const sig = await sign(this.auth.signPrivate, utf8(authString(method, pathAndQuery, ts, nonce, await bodyHash(body))));
      headers.authorization = `AN1 member=${this.auth.member},ts=${ts},nonce=${nonce},sig=${sig}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/orgs/${this.org}${pathAndQuery}`, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new HubError(0, `hub unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    if (!response.ok) throw new HubError(response.status, parsed?.error ?? `HTTP ${response.status}`);
    return parsed as T;
  }

  info() {
    return this.call<{ org: string; initialized: boolean; root: string | null; root_sign_pub: string | null }>('GET', '/info', { signed: false });
  }

  /** Creates the org with this root. `auth` is the shared bootstrap token (self-hosted) or a provision ticket from your account. */
  init(cert: MemberCert, certSig: string, auth: string | { ticket: string }) {
    const headers: Record<string, string> = typeof auth === 'string' ? { 'x-bootstrap-token': auth } : { 'x-provision-ticket': auth.ticket };
    return this.call('POST', '/init', { body: { cert, cert_sig: certSig }, headers, signed: false });
  }

  createInvite(record: InviteRecord, sig: string) {
    return this.call('POST', '/invites', { body: { record, sig } });
  }

  join(request: JoinRequest, sig: string) {
    return this.call<{ status: string; message: string }>('POST', '/join', { body: { request, sig }, signed: false });
  }

  pending() {
    return this.call<DirectoryEntry[]>('GET', '/pending');
  }

  certify(cert: MemberCert, certSig: string) {
    return this.call('POST', '/members', { body: { cert, cert_sig: certSig } });
  }

  revoke(developer: string, revocation: Revocation, sig: string) {
    return this.call('POST', `/members/${encodeURIComponent(developer)}/revoke`, { body: { revocation, sig } });
  }

  directory() {
    return this.call<DirectoryEntry[]>('GET', '/directory');
  }

  presence() {
    return this.call<{ online: string[] }>('GET', '/presence');
  }

  post(envelope: Envelope) {
    return this.call<PostResult>('POST', '/messages', { body: envelope });
  }

  messages(after: number, limit = 100) {
    return this.call<{ messages: Array<{ seq: number; envelope: Envelope }>; cursor: number; more: boolean }>('GET', '/messages', {
      query: { after: String(after), limit: String(limit) },
    });
  }

  /** Signed WebSocket URL (browsers and Node's WebSocket cannot send custom headers). */
  async socketUrl(): Promise<string> {
    if (!this.auth) throw new Error('socket requires member credentials');
    const ts = Date.now();
    const nonce = randomId();
    const member = this.auth.member;
    const sig = await sign(this.auth.signPrivate, utf8(authString('GET', `/ws?member=${encodeURIComponent(member)}`, ts, nonce, await bodyHash(''))));
    const query = new URLSearchParams({ member, ts: String(ts), nonce, sig }).toString();
    return `${this.baseUrl.replace(/^http/, 'ws')}/v1/orgs/${this.org}/ws?${query}`;
  }
}
