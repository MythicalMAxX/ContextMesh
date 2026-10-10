/**
 * `agent-network doctor`: checks, in one line each, everything that stops an agent on a fresh computer from using the network
 * (the Node version, the node folder, the hub, the clock, whether the admin has approved the join) and says how to fix what is
 * wrong. It must run on a Node that is too old to run the rest of the client, so it imports nothing that needs a newer Node
 * until the version check has passed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_NODE = { major: 22, minor: 18 } as const;

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export const nodeTooOld = (version = process.versions.node): boolean => {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor);
};

/** The user-space Node 22 install (no root needed), the same text the quickstart gives. */
export const NODE_INSTALL_FIX =
  'Install Node 22 without root: V=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-x64.tar.gz" | head -1); mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/latest-v22.x/$V | tar -xz -C ~/.local/node --strip-components=1; export PATH=$HOME/.local/node/bin:$PATH   (then add that PATH line to ~/.bashrc)';

export async function runDoctor(options: { home: string; hub?: string; fetch?: typeof fetch }): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (check: Check) => void checks.push(check);
  const doFetch = options.fetch ?? fetch;

  if (nodeTooOld()) {
    add({ name: 'node', status: 'fail', detail: `Node.js ${process.versions.node} is too old; agent-network needs ${MIN_NODE.major}.${MIN_NODE.minor} or newer`, fix: NODE_INSTALL_FIX });
  } else {
    add({ name: 'node', status: 'ok', detail: `Node.js ${process.versions.node}` });
    try {
      await import('node:sqlite');
      add({ name: 'sqlite', status: 'ok', detail: 'node:sqlite is available' });
    } catch {
      add({ name: 'sqlite', status: 'fail', detail: 'node:sqlite is missing from this Node build', fix: 'Use an official Node.js 22.18 or newer build.' });
    }
  }

  const nodeFile = join(options.home, 'node.yaml');
  const hasNode = existsSync(nodeFile);
  let hub = options.hub?.replace(/\/+$/, '') ?? null;
  let org: string | null = null;
  if (!hasNode) {
    add({ name: 'node folder', status: 'warn', detail: `no node in ${options.home} yet (normal before "agent-network join")`, fix: 'Join with the invite code you were given: agent-network join <invite-code>' });
  } else {
    try {
      mkdirSync(options.home, { recursive: true });
      const probe = join(options.home, '.doctor-write-test');
      writeFileSync(probe, 'ok');
      rmSync(probe);
      add({ name: 'node folder', status: 'ok', detail: `${options.home} exists and is writable` });
    } catch (error) {
      add({ name: 'node folder', status: 'fail', detail: `${options.home} is not writable: ${error instanceof Error ? error.message : String(error)}`, fix: 'Point AGENT_NETWORK_HOME at a folder that is kept between your tasks and that you can write to.' });
    }
    try {
      const { loadNodeConfig } = await import('../config.ts');
      const settings = loadNodeConfig(nodeFile);
      hub = hub ?? settings.hub;
      org = settings.org;
      add({ name: 'identity', status: existsSync(join(options.home, settings.identity)) ? 'ok' : 'fail', detail: existsSync(join(options.home, settings.identity)) ? `you are ${settings.developer} in org ${settings.org}` : `${settings.identity} is missing`, fix: existsSync(join(options.home, settings.identity)) ? undefined : 'The node folder is incomplete. Ask your admin for a new invite and join again in an empty folder.' });
    } catch (error) {
      add({ name: 'node config', status: 'fail', detail: error instanceof Error ? error.message.split('\n')[0]! : String(error), fix: 'Fix node.yaml or join again in an empty folder.' });
    }
  }

  if (hub) {
    const started = Date.now();
    try {
      const response = await doFetch(`${hub}/healthz`, { signal: AbortSignal.timeout(15_000) });
      const body = (await response.json().catch(() => null)) as { service?: string; protocol?: number } | null;
      if (response.ok && body?.service?.startsWith('agent-network-hub')) {
        add({ name: 'hub', status: 'ok', detail: `${hub} answered in ${Date.now() - started} ms (protocol ${body.protocol})` });
        const serverDate = response.headers.get('date');
        if (serverDate) {
          const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
          if (Math.abs(skew) > 300) add({ name: 'clock', status: 'fail', detail: `this computer's clock is ${Math.abs(skew)} s ${skew > 0 ? 'ahead of' : 'behind'} the hub; signed messages will be refused`, fix: 'Set the system clock (for example: sudo timedatectl set-ntp true).' });
          else if (Math.abs(skew) > 60) add({ name: 'clock', status: 'warn', detail: `this computer's clock differs from the hub by ${Math.abs(skew)} s` });
          else add({ name: 'clock', status: 'ok', detail: `clock within ${Math.abs(skew)} s of the hub` });
        }
      } else {
        add({ name: 'hub', status: 'fail', detail: `${hub} answered, but it is not an agent-network hub (HTTP ${response.status})`, fix: 'Check the hub address in your instructions.' });
      }
    } catch (error) {
      add({ name: 'hub', status: 'fail', detail: `cannot reach ${hub}: ${error instanceof Error ? error.message : String(error)}`, fix: 'Check that this computer can make outbound HTTPS requests to that address (for example: curl -sS <hub>/healthz).' });
    }
  } else if (hasNode) {
    add({ name: 'hub', status: 'warn', detail: 'no hub address known', fix: 'Run: agent-network doctor --hub https://<hub-address>' });
  }

  // Whether the admin has approved this member: the directory is only served to approved members.
  if (hasNode && !nodeTooOld() && checks.every((check) => check.name === 'hub' || check.status !== 'fail')) {
    try {
      const { LocalNode } = await import('./node.ts');
      const node = await LocalNode.open({ home: options.home, log: () => undefined, fetch: options.fetch });
      try {
        const members = await node.refreshDirectory();
        const me = members.find((member) => member.id === node.developer);
        if (me?.status === 'active') add({ name: 'membership', status: 'ok', detail: `${node.developer} is an approved member (${members.filter((m) => m.status === 'active').length} active in the org)` });
        else add({ name: 'membership', status: 'warn', detail: `${node.developer} is not approved yet`, fix: `Tell your admin your fingerprint so they can approve you, then run doctor again.` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pending = /401|403|not (a )?member|unauthor|pending|unknown member/i.test(message);
        add({ name: 'membership', status: pending ? 'warn' : 'fail', detail: pending ? `${node.developer} is not approved yet (${message})` : message, fix: pending ? 'Tell your admin your fingerprint (shown when you joined) so they can approve you, then run doctor again.' : 'Check the hub address and try again.' });
      } finally {
        node.close();
      }
    } catch (error) {
      add({ name: 'membership', status: 'fail', detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
    }
  }
  void org;
  return { ok: checks.every((check) => check.status !== 'fail'), checks };
}

export function formatDoctor(result: { ok: boolean; checks: Check[] }): string {
  const label = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' } as const;
  const lines = result.checks.map((check) => `${label[check.status]}  ${check.name}: ${check.detail}${check.fix ? `\n      fix: ${check.fix}` : ''}`);
  lines.push('', result.ok ? 'Nothing blocks you.' : 'Fix the FAIL lines above, then run: agent-network doctor');
  return lines.join('\n');
}
