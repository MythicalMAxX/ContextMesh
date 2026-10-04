/**
 * Your account on a multi-tenant hub: sign in with an email code, then create orgs without any shared platform secret.
 * The account only proves who you are to the hub's control plane. Org content and keys never pass through it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HubError } from './hub-client.ts';

export interface AccountSession {
  token: string;
  email: string;
  expires_at: string;
}

export interface Reservation {
  org: string;
  plan: string;
  limits: Record<string, number> | null;
  ticket: string;
  ticket_expires_at: string;
}

const accountFile = (): string => process.env.AGENT_NETWORK_ACCOUNT ?? join(homedir(), '.agent-network-account.json');
const hubKey = (hub: string): string => hub.replace(/\/+$/, '');

function readStore(): Record<string, AccountSession> {
  try {
    return JSON.parse(readFileSync(accountFile(), 'utf8')) as Record<string, AccountSession>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, AccountSession>): void {
  const file = accountFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not supported on every file system.
  }
}

/** The saved sign-in for this hub, if there is one and it has not expired. */
export function loadSession(hub: string): AccountSession | null {
  const session = readStore()[hubKey(hub)];
  return session && Date.parse(session.expires_at) > Date.now() ? session : null;
}

export function logout(hub: string): boolean {
  const store = readStore();
  const had = hubKey(hub) in store;
  delete store[hubKey(hub)];
  if (had || existsSync(accountFile())) writeStore(store);
  return had;
}

async function call<T>(hub: string, method: 'GET' | 'POST', path: string, options: { body?: unknown; token?: string; fetch?: typeof fetch } = {}): Promise<T> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${hubKey(hub)}${path}`, {
      method,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
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

/** Asks the hub to email a one-time sign-in code. `dev_code` is only present on local development hubs. */
export function requestLoginCode(hub: string, email: string, f?: typeof fetch) {
  return call<{ ok: boolean; expires_in: number; dev_code?: string }>(hub, 'POST', '/v1/auth/start', { body: { email }, fetch: f });
}

export async function completeLogin(hub: string, email: string, code: string, f?: typeof fetch): Promise<AccountSession> {
  const result = await call<{ token: string; user: { email: string }; expires_at: string }>(hub, 'POST', '/v1/auth/verify', { body: { email, code }, fetch: f });
  const session = { token: result.token, email: result.user.email, expires_at: result.expires_at };
  writeStore({ ...readStore(), [hubKey(hub)]: session });
  return session;
}

export function whoami(hub: string, session: AccountSession, f?: typeof fetch) {
  return call<{ user: { id: string; email: string }; orgs: Array<{ id: string; plan: string; status: string; limits: Record<string, number> | null }> }>(hub, 'GET', '/v1/me', { token: session.token, fetch: f });
}

/** Reserves an org name for this root key. The returned ticket lets the org's hub accept exactly that key at /init. */
export function reserveOrg(hub: string, session: AccountSession, org: string, rootSignPub: string, f?: typeof fetch) {
  return call<Reservation>(hub, 'POST', '/v1/orgs', { body: { org, root_sign_pub: rootSignPub }, token: session.token, fetch: f });
}

/** CLI: login | logout | whoami */
export async function runAccountCommand(command: string, values: Record<string, string | boolean | undefined>, print: (value: unknown) => void): Promise<void> {
  const hub = typeof values.hub === 'string' ? values.hub : process.env.AGENT_NETWORK_HUB;
  if (!hub) throw new Error(`usage: ${command} --hub URL${command === 'login' ? ' --email you@example.com' : ''}   (or set AGENT_NETWORK_HUB)`);

  if (command === 'logout') return print(logout(hub) ? 'Signed out.' : 'You were not signed in to that hub.');

  if (command === 'whoami') {
    const session = loadSession(hub);
    if (!session) throw new Error(`Not signed in to ${hub}. Run: agent-network login --hub ${hub} --email you@example.com`);
    return print(await whoami(hub, session));
  }

  const email = typeof values.email === 'string' ? values.email : undefined;
  if (!email) throw new Error('usage: login --hub URL --email you@example.com [--code 123456]');
  let code = typeof values.code === 'string' ? values.code : undefined;
  if (!code) {
    const sent = await requestLoginCode(hub, email);
    print(`We emailed a 6-digit code to ${email}. It works for ${Math.round(sent.expires_in / 60)} minutes.`);
    if (sent.dev_code) print(`(Development hub: your code is ${sent.dev_code})`);
    if (!process.stdin.isTTY) return print(`Then run: agent-network login --hub ${hub} --email ${email} --code <the code>`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      code = (await rl.question('Code: ')).trim();
    } finally {
      rl.close();
    }
  }
  const session = await completeLogin(hub, email, code);
  print(`Signed in as ${session.email}. Create your org with: agent-network org init --hub ${hub} --org my-team --developer you --manifest org.yaml`);
}
