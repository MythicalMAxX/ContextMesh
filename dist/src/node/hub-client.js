import { randomId, sign, utf8 } from '../../shared/crypto.js';
import { authString, bodyHash, } from '../../shared/protocol.js';
export class HubError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = 'HubError';
        this.status = status;
    }
}
/** HTTPS client for the hub. Every authenticated call is signed with the member's Ed25519 key. */
export class HubClient {
    baseUrl;
    org;
    auth;
    fetchImpl;
    constructor(baseUrl, org, auth, fetchImpl = fetch) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.org = org;
        this.auth = auth;
        this.fetchImpl = fetchImpl;
    }
    async call(method, path, options = {}) {
        const query = options.query ? new URLSearchParams(options.query).toString() : '';
        const pathAndQuery = query ? `${path}?${query}` : path;
        const body = options.body === undefined ? '' : JSON.stringify(options.body);
        const headers = { accept: 'application/json', ...(options.headers ?? {}) };
        if (body)
            headers['content-type'] = 'application/json';
        if (options.signed !== false && this.auth) {
            const ts = Date.now();
            const nonce = randomId();
            const sig = await sign(this.auth.signPrivate, utf8(authString(method, pathAndQuery, ts, nonce, await bodyHash(body))));
            headers.authorization = `AN1 member=${this.auth.member},ts=${ts},nonce=${nonce},sig=${sig}`;
        }
        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/v1/orgs/${this.org}${pathAndQuery}`, {
                method,
                headers,
                body: body || undefined,
                signal: AbortSignal.timeout(30_000),
            });
        }
        catch (error) {
            throw new HubError(0, `hub unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = await response.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch {
            parsed = { error: text.slice(0, 200) };
        }
        if (!response.ok)
            throw new HubError(response.status, parsed?.error ?? `HTTP ${response.status}`);
        return parsed;
    }
    info() {
        return this.call('GET', '/info', { signed: false });
    }
    init(cert, certSig, bootstrapToken) {
        return this.call('POST', '/init', { body: { cert, cert_sig: certSig }, headers: { 'x-bootstrap-token': bootstrapToken }, signed: false });
    }
    createInvite(record, sig) {
        return this.call('POST', '/invites', { body: { record, sig } });
    }
    join(request, sig) {
        return this.call('POST', '/join', { body: { request, sig }, signed: false });
    }
    pending() {
        return this.call('GET', '/pending');
    }
    certify(cert, certSig) {
        return this.call('POST', '/members', { body: { cert, cert_sig: certSig } });
    }
    revoke(developer, revocation, sig) {
        return this.call('POST', `/members/${encodeURIComponent(developer)}/revoke`, { body: { revocation, sig } });
    }
    directory() {
        return this.call('GET', '/directory');
    }
    presence() {
        return this.call('GET', '/presence');
    }
    post(envelope) {
        return this.call('POST', '/messages', { body: envelope });
    }
    messages(after, limit = 100) {
        return this.call('GET', '/messages', {
            query: { after: String(after), limit: String(limit) },
        });
    }
    /** Signed WebSocket URL (browsers and Node's WebSocket cannot send custom headers). */
    async socketUrl() {
        if (!this.auth)
            throw new Error('socket requires member credentials');
        const ts = Date.now();
        const nonce = randomId();
        const member = this.auth.member;
        const sig = await sign(this.auth.signPrivate, utf8(authString('GET', `/ws?member=${encodeURIComponent(member)}`, ts, nonce, await bodyHash(''))));
        const query = new URLSearchParams({ member, ts: String(ts), nonce, sig }).toString();
        return `${this.baseUrl.replace(/^http/, 'ws')}/v1/orgs/${this.org}/ws?${query}`;
    }
}
//# sourceMappingURL=hub-client.js.map