import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  decryptWithPassphrase,
  encryptWithPassphrase,
  fingerprint,
  fromUtf8,
  generateBoxKeys,
  generateSigningKeys,
  utf8,
  type KeyPair,
} from '../../shared/crypto.ts';

/** A member's key material. Private keys never leave this machine. */
export interface Keys {
  org: string;
  developer: string;
  name: string | null;
  hub: string;
  /** The org root's signing key, pinned at join time. Every member certificate must chain to it. */
  root: { id: string; sign_pub: string; fingerprint: string };
  sign: KeyPair;
  box: KeyPair;
}

interface IdentityFile {
  v: 1;
  org: string;
  developer: string;
  name: string | null;
  hub: string;
  root: Keys['root'];
  sign_pub: string;
  box_pub: string;
  /** Present when the file is not passphrase-protected. */
  private?: { sign: string; box: string };
  /** Present when AGENT_NETWORK_PASSPHRASE was set at creation. */
  protected?: { salt: string; iterations: number; nonce: string; ct: string };
  created_at: string;
}

export async function generateKeys(): Promise<{ sign: KeyPair; box: KeyPair }> {
  return { sign: await generateSigningKeys(), box: await generateBoxKeys() };
}

export async function saveIdentity(path: string, keys: Keys, passphrase = process.env.AGENT_NETWORK_PASSPHRASE): Promise<void> {
  const secrets = { sign: keys.sign.private, box: keys.box.private };
  const file: IdentityFile = {
    v: 1,
    org: keys.org,
    developer: keys.developer,
    name: keys.name,
    hub: keys.hub,
    root: keys.root,
    sign_pub: keys.sign.public,
    box_pub: keys.box.public,
    ...(passphrase ? { protected: await encryptWithPassphrase(passphrase, utf8(JSON.stringify(secrets))) } : { private: secrets }),
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every file system (e.g. Windows); rely on the user profile's ACLs there.
  }
}

export async function loadIdentity(path: string, passphrase = process.env.AGENT_NETWORK_PASSPHRASE): Promise<Keys> {
  if (!existsSync(path)) throw new Error(`Identity not found at ${path}. Run "agent-network join" or "agent-network org init" first.`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile;
  let secrets = file.private;
  if (!secrets && file.protected) {
    if (!passphrase) throw new Error('This identity is passphrase-protected: set AGENT_NETWORK_PASSPHRASE.');
    try {
      secrets = JSON.parse(fromUtf8(await decryptWithPassphrase(passphrase, file.protected))) as { sign: string; box: string };
    } catch {
      throw new Error('Wrong AGENT_NETWORK_PASSPHRASE for this identity.');
    }
  }
  if (!secrets) throw new Error(`Identity file ${path} has no private keys.`);
  return {
    org: file.org,
    developer: file.developer,
    name: file.name,
    hub: file.hub,
    root: file.root,
    sign: { public: file.sign_pub, private: secrets.sign },
    box: { public: file.box_pub, private: secrets.box },
  };
}

export async function rootFromKeys(developer: string, signPub: string): Promise<Keys['root']> {
  return { id: developer, sign_pub: signPub, fingerprint: await fingerprint(signPub) };
}
