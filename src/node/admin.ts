/**
 * Org membership: bootstrap, invites, joining, certification and revocation. The org root's signing key is the
 * trust anchor; the hub stores certificates but cannot mint them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { fingerprint, fromB64u, fromUtf8, randomBytes, randomId, signJson, signingKeysFromSeed, toB64u, utf8 } from '../../shared/crypto.ts';
import type { InviteRecord, JoinRequest, MemberCert, Revocation } from '../../shared/protocol.ts';
import { validateManifest, type Manifest } from '../config.ts';
import { reserveOrg, type AccountSession } from './account.ts';
import { activeMembers } from './directory.ts';
import { HubClient } from './hub-client.ts';
import { generateKeys, rootFromKeys, saveIdentity, type Keys } from './identity.ts';
import { LocalNode, chunkUpdate } from './node.ts';

function writeNodeConfig(home: string, settings: { hub: string; org: string; developer: string }): void {
  mkdirSync(home, { recursive: true });
  const text = `${toYaml({ hub: settings.hub, org: settings.org, developer: settings.developer, identity: 'identity.json', database: 'graph.db' })}
# Start here: run "agent-network setup". It asks which folder(s) are your project and which AI tool and model to use
# for background work, and writes the sections below for you.
#
# What agents may look at (nothing outside these folders is indexed or served, and agents are told this map):
# projects:
#   resource-service:
#     description: Resource API (Go). Run make test.
#     paths: [D:/code/resource-service]
#     repository: resource-service
#
# How this node runs an agent by itself. You choose the tool and the model; there is no silent default:
# agents:
#   profiles:
#     background: { tool: claude-code, model: haiku }
#
# Local checkouts this node indexes and publishes (a project with "repository:" already provides one):
# repositories:
#   resource-service: { path: D:/code/resource-service }
#
# Task sources (optional): file, jira or linear
# tasks:
#   - { type: file, path: tasks.yaml }
#
# How shared memory from other members is applied: owner_authoritative | all | manual
# policy: { apply_updates: owner_authoritative }
#
# Answer URGENT enquiries while you are away with a read-only headless agent (off by default):
# responder:
#   enabled: true
#   profile: background
#   timeout_seconds: 120
`;
  writeFileSync(join(home, 'node.yaml'), text);
}

/** Creates the org on the hub with this developer as root, and publishes the first manifest. */
export async function initOrg(options: {
  home: string;
  hub: string;
  org: string;
  developer: string;
  name?: string;
  manifest: Manifest;
  /** Self-hosted hubs: the shared bootstrap secret. */
  bootstrapToken?: string;
  /** Multi-tenant hubs: your signed-in account. The org name is reserved for this root key first. */
  account?: AccountSession;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ node: LocalNode; fingerprint: string }> {
  if (!options.bootstrapToken && !options.account) throw new Error('Creating an org needs either a signed-in account (agent-network login) or the hub\'s BOOTSTRAP_TOKEN.');
  const manifest = validateManifest(options.manifest);
  if (!manifest.developers[options.developer]) throw new Error(`The manifest must list the org root "${options.developer}" under developers.`);
  const home = resolve(options.home);
  const generated = await generateKeys();
  const keys: Keys = {
    org: options.org,
    developer: options.developer,
    name: options.name ?? manifest.developers[options.developer]?.name ?? null,
    hub: options.hub,
    root: await rootFromKeys(options.developer, generated.sign.public),
    ...generated,
  };
  const cert: MemberCert = {
    v: 1,
    org: options.org,
    developer: options.developer,
    name: keys.name,
    sign_pub: keys.sign.public,
    box_pub: keys.box.public,
    roles: ['root', 'admin'],
    issued_at: new Date().toISOString(),
    issuer: options.developer,
  };
  const hub = new HubClient(options.hub, options.org, null, options.fetch);
  const auth = options.bootstrapToken ?? { ticket: (await reserveOrg(options.hub, options.account!, options.org, keys.sign.public, options.fetch)).ticket };
  await hub.init(cert, await signJson(keys.sign.private, cert), auth);
  await saveIdentity(join(home, 'identity.json'), keys);
  writeNodeConfig(home, { hub: options.hub, org: options.org, developer: options.developer });
  const node = await LocalNode.open({ home, fetch: options.fetch, log: options.log });
  node.applyManifest(1, manifest);
  await node.refreshDirectory();
  return { node, fingerprint: keys.root.fingerprint };
}

interface InviteCode {
  h: string;
  o: string;
  i: string;
  s: string;
  r: string;
  k: string;
  d: string;
}

/** Issues a single-use invite. The code is a secret: send it over a trusted channel. */
export async function createInvite(node: LocalNode, developer: string, hours = 72): Promise<{ code: string; expires_at: string }> {
  if (!node.isRoot(node.developer)) throw new Error('Only the org root can invite members.');
  if (!node.manifest()?.manifest.developers[developer]) throw new Error(`Add ${developer} to the manifest (and publish it) before inviting them.`);
  const seed = randomBytes(32);
  const inviteKeys = await signingKeysFromSeed(seed);
  const record: InviteRecord = {
    v: 1,
    org: node.keys.org,
    id: randomId('i'),
    developer,
    invite_pub: inviteKeys.public,
    expires_at: new Date(Date.now() + Math.min(hours, 168) * 3_600_000).toISOString(),
    issuer: node.developer,
  };
  await node.hub.createInvite(record, await signJson(node.keys.sign.private, record));
  const code: InviteCode = { h: node.settings.hub, o: node.keys.org, i: record.id, s: toB64u(seed), r: node.keys.root.id, k: node.keys.root.sign_pub, d: developer };
  return { code: `an1_${toB64u(utf8(JSON.stringify(code)))}`, expires_at: record.expires_at };
}

export function parseInvite(code: string): InviteCode {
  if (!code.startsWith('an1_')) throw new Error('Not an agent-network invite code.');
  try {
    return JSON.parse(fromUtf8(fromB64u(code.slice(4)))) as InviteCode;
  } catch {
    throw new Error('Invite code is corrupted.');
  }
}

/** Generates this member's keys, pins the org root from the invite, and registers with the hub. */
export async function joinOrg(options: { home: string; code: string; name?: string; fetch?: typeof fetch }): Promise<{ developer: string; fingerprint: string; root_fingerprint: string }> {
  const invite = parseInvite(options.code);
  const hub = new HubClient(invite.h, invite.o, null, options.fetch);
  const info = await hub.info();
  if (info.root !== invite.r || info.root_sign_pub !== invite.k) {
    throw new Error('The hub does not present the org root from your invite. Do not proceed; ask your admin.');
  }
  const generated = await generateKeys();
  const keys: Keys = {
    org: invite.o,
    developer: invite.d,
    name: options.name ?? null,
    hub: invite.h,
    root: await rootFromKeys(invite.r, invite.k),
    ...generated,
  };
  const request: JoinRequest = {
    v: 1,
    org: invite.o,
    invite_id: invite.i,
    developer: invite.d,
    name: keys.name,
    sign_pub: keys.sign.public,
    box_pub: keys.box.public,
  };
  const inviteKeys = await signingKeysFromSeed(fromB64u(invite.s));
  await hub.join(request, await signJson(inviteKeys.private, request));
  const home = resolve(options.home);
  await saveIdentity(join(home, 'identity.json'), keys);
  writeNodeConfig(home, { hub: invite.h, org: invite.o, developer: invite.d });
  return { developer: invite.d, fingerprint: await fingerprint(keys.sign.public), root_fingerprint: keys.root.fingerprint };
}

export async function pendingJoins(node: LocalNode) {
  const pending = await node.hub.pending();
  return Promise.all(pending.map(async (p) => ({ developer: p.id, fingerprint: await fingerprint(p.sign_pub) })));
}

/**
 * Certifies a pending member (after checking their fingerprint out of band), then sends them the manifest and a
 * snapshot of the shared memory they are allowed to read.
 */
export async function approveMember(node: LocalNode, developer: string, expectedFingerprint?: string) {
  if (!node.isRoot(node.developer)) throw new Error('Only the org root can approve members.');
  const pending = (await node.hub.pending()).find((p) => p.id === developer);
  if (!pending) throw new Error(`${developer} has no pending join request.`);
  const actual = await fingerprint(pending.sign_pub);
  if (expectedFingerprint && expectedFingerprint.replace(/-/g, '') !== actual.replace(/-/g, '')) {
    throw new Error(`Fingerprint mismatch for ${developer}: expected ${expectedFingerprint}, hub has ${actual}. Do not approve.`);
  }
  const manifest = node.manifest();
  const dev = manifest?.manifest.developers[developer];
  const cert: MemberCert = {
    v: 1,
    org: node.keys.org,
    developer,
    name: dev?.name ?? null,
    sign_pub: pending.sign_pub,
    box_pub: pending.box_pub,
    roles: dev?.admin ? ['admin'] : [],
    issued_at: new Date().toISOString(),
    issuer: node.developer,
  };
  await node.hub.certify(cert, await signJson(node.keys.sign.private, cert));
  await node.refreshDirectory();
  const member = node.activeMember(developer);
  if (!member) throw new Error(`${developer} was certified but did not verify locally.`);
  if (manifest) await node.send({ kind: 'manifest', priority: 'low', to: [member], payload: { version: manifest.version, manifest: manifest.manifest } });
  const chunks = chunkUpdate(node.exportGraph(developer));
  const snapshotId = randomId('s');
  for (const [part, graph] of chunks.entries()) {
    await node.send({ kind: 'snapshot', priority: 'low', to: [member], payload: { snapshot_id: snapshotId, part, parts: chunks.length, graph } });
  }
  return { developer, fingerprint: actual, snapshot_parts: chunks.length };
}

export async function revokeMember(node: LocalNode, developer: string) {
  if (!node.isRoot(node.developer)) throw new Error('Only the org root can revoke members.');
  const revocation: Revocation = { v: 1, org: node.keys.org, developer, revoked_at: new Date().toISOString(), issuer: node.developer };
  await node.hub.revoke(developer, revocation, await signJson(node.keys.sign.private, revocation));
  await node.refreshDirectory();
  return { developer, status: 'revoked', note: 'New messages are no longer encrypted for them. Remove them from the manifest and publish it.' };
}

/** Publishes a new manifest version to every active member (signed by the root, encrypted per member). */
export async function publishManifest(node: LocalNode, raw: unknown) {
  if (!node.isRoot(node.developer)) throw new Error('Only the org root can publish the manifest.');
  const manifest = validateManifest(raw);
  const version = (node.manifest()?.version ?? 0) + 1;
  node.applyManifest(version, manifest);
  await node.refreshDirectory();
  const to = activeMembers(node.ctx).filter((m) => m.id !== node.developer);
  if (to.length) await node.send({ kind: 'manifest', priority: 'low', to, payload: { version, manifest } });
  return { version, sent_to: to.map((m) => m.id) };
}
