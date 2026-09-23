/**
 * Runtime-neutral cryptography (Web Crypto only), shared by the Cloudflare hub and local nodes.
 *
 *  - Identity:   Ed25519 signing keys + X25519 key-agreement keys per member.
 *  - Sealing:    a content key is wrapped for each recipient with ephemeral X25519 ECDH → HKDF-SHA256 → AES-256-GCM.
 *  - Content:    AES-256-GCM with the envelope header as associated data, so metadata cannot be swapped.
 *  - Signatures: Ed25519 over canonical JSON.
 */

const subtle = crypto.subtle;
// Node and Workers expose Web Crypto types under different names; derive them from the API itself.
type Key = Awaited<ReturnType<typeof subtle.importKey>>;
type Pair = { publicKey: Key; privateKey: Key };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function toB64u(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

export function randomId(prefix = ''): string {
  return `${prefix}${toB64u(randomBytes(16))}`;
}

/** Deterministic JSON: object keys sorted, undefined dropped. Used for everything that is signed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Constant-time comparison for secrets such as bootstrap tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Web Crypto accepts BufferSource; copying into a fresh ArrayBuffer keeps TypeScript and all runtimes happy.
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const exportRaw = async (key: Key, format: 'raw' | 'pkcs8') => new Uint8Array((await subtle.exportKey(format, key)) as ArrayBuffer);
// Node and Workers type the X25519 parameters differently ("public" vs "$public"); the runtime shape is standard.
const ecdh = (peer: Key) => ({ name: 'X25519', public: peer }) as unknown as Parameters<typeof subtle.deriveBits>[0];

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', buf(data)));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface KeyPair {
  /** Raw public key, base64url. */
  public: string;
  /** PKCS#8 private key, base64url. */
  private: string;
}

const ED25519 = { name: 'Ed25519' } as const;
const X25519 = { name: 'X25519' } as const;

async function exportPair(pair: Pair): Promise<KeyPair> {
  return {
    public: toB64u(await exportRaw(pair.publicKey, 'raw')),
    private: toB64u(await exportRaw(pair.privateKey, 'pkcs8')),
  };
}

export async function generateSigningKeys(): Promise<KeyPair> {
  return exportPair((await subtle.generateKey(ED25519, true, ['sign', 'verify'])) as Pair);
}

export async function generateBoxKeys(): Promise<KeyPair> {
  return exportPair((await subtle.generateKey(X25519, true, ['deriveBits'])) as Pair);
}

// RFC 8410 PKCS#8 prefix for a 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** Derives an Ed25519 key pair from a 32-byte seed (used for one-time invite keys). */
export async function signingKeysFromSeed(seed: Uint8Array): Promise<KeyPair> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const pkcs8 = concat(ED25519_PKCS8_PREFIX, seed);
  const key = await subtle.importKey('pkcs8', buf(pkcs8), ED25519, true, ['sign']);
  const jwk = (await subtle.exportKey('jwk', key)) as { x?: string };
  if (!jwk.x) throw new Error('runtime did not expose the Ed25519 public key');
  return { public: jwk.x, private: toB64u(pkcs8) };
}

const keyCache = new Map<string, Promise<Key>>();

function cachedKey(cacheKey: string, load: () => Promise<Key>): Promise<Key> {
  let key = keyCache.get(cacheKey);
  if (!key) {
    if (keyCache.size > 500) keyCache.clear();
    key = load();
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
  }
  return key;
}

const signingKey = (pkcs8: string) => cachedKey(`es:${pkcs8}`, () => subtle.importKey('pkcs8', buf(fromB64u(pkcs8)), ED25519, false, ['sign']));
const verifyKey = (raw: string) => cachedKey(`ev:${raw}`, () => subtle.importKey('raw', buf(fromB64u(raw)), ED25519, false, ['verify']));
const boxPrivate = (pkcs8: string) => cachedKey(`xs:${pkcs8}`, () => subtle.importKey('pkcs8', buf(fromB64u(pkcs8)), X25519, false, ['deriveBits']));
const boxPublic = (raw: string) => cachedKey(`xp:${raw}`, () => subtle.importKey('raw', buf(fromB64u(raw)), X25519, true, []));

export async function sign(privateKey: string, data: Uint8Array): Promise<string> {
  return toB64u(new Uint8Array(await subtle.sign(ED25519, await signingKey(privateKey), buf(data))));
}

export async function verify(publicKey: string, data: Uint8Array, signature: string): Promise<boolean> {
  try {
    return await subtle.verify(ED25519, await verifyKey(publicKey), buf(fromB64u(signature)), buf(data));
  } catch {
    return false;
  }
}

export const signJson = (privateKey: string, value: unknown) => sign(privateKey, utf8(canonicalJson(value)));
export const verifyJson = (publicKey: string, value: unknown, signature: string) => verify(publicKey, utf8(canonicalJson(value)), signature);

/** Short, human-comparable fingerprint of a signing key ("safety number"). */
export async function fingerprint(publicKey: string): Promise<string> {
  const digest = await sha256(fromB64u(publicKey));
  return [...digest.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('').replace(/(.{4})(?!$)/g, '$1-');
}

// ---------------------------------------------------------------------------
// Symmetric encryption
// ---------------------------------------------------------------------------

async function aesKey(raw: Uint8Array, usage: Array<'encrypt' | 'decrypt'>): Promise<Key> {
  return subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, usage);
}

export async function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<{ nonce: string; ct: string }> {
  const nonce = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, await aesKey(key, ['encrypt']), buf(plaintext));
  return { nonce: toB64u(nonce), ct: toB64u(new Uint8Array(ct)) };
}

export async function aeadDecrypt(key: Uint8Array, nonce: string, ct: string, aad: Uint8Array): Promise<Uint8Array> {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: buf(fromB64u(nonce)), additionalData: buf(aad) },
    await aesKey(key, ['decrypt']),
    buf(fromB64u(ct)),
  );
  return new Uint8Array(pt);
}

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8(info)) }, base, 256));
}

/**
 * Encrypts a small secret (a content key) for one recipient. Output: ephemeral public key ‖ nonce ‖ ciphertext.
 * `context` is bound into the key derivation so a wrap cannot be moved to another message or recipient.
 */
export async function seal(recipientBoxPublic: string, secret: Uint8Array, context: string): Promise<string> {
  const ephemeral = (await subtle.generateKey(X25519, true, ['deriveBits'])) as Pair;
  const ephemeralPublic = await exportRaw(ephemeral.publicKey, 'raw');
  const recipient = fromB64u(recipientBoxPublic);
  const shared = new Uint8Array(await subtle.deriveBits(ecdh(await boxPublic(recipientBoxPublic)), ephemeral.privateKey, 256));
  const key = await hkdf(shared, concat(ephemeralPublic, recipient), `an1-seal:${context}`);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, await aesKey(key, ['encrypt']), buf(secret)));
  return toB64u(concat(ephemeralPublic, nonce, ct));
}

export async function unseal(ownBoxPrivate: string, ownBoxPublic: string, sealed: string, context: string): Promise<Uint8Array> {
  const bytes = fromB64u(sealed);
  if (bytes.length < 32 + 12 + 16) throw new Error('sealed value too short');
  const ephemeralPublic = bytes.subarray(0, 32);
  const nonce = bytes.subarray(32, 44);
  const ct = bytes.subarray(44);
  const peer = await subtle.importKey('raw', buf(ephemeralPublic), X25519, true, []);
  const shared = new Uint8Array(await subtle.deriveBits(ecdh(peer), await boxPrivate(ownBoxPrivate), 256));
  const key = await hkdf(shared, concat(ephemeralPublic, fromB64u(ownBoxPublic)), `an1-seal:${context}`);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, await aesKey(key, ['decrypt']), buf(ct)));
}

// ---------------------------------------------------------------------------
// Passphrase protection for private key files
// ---------------------------------------------------------------------------

export async function encryptWithPassphrase(passphrase: string, plaintext: Uint8Array): Promise<{ salt: string; iterations: number; nonce: string; ct: string }> {
  const salt = randomBytes(16);
  const iterations = 600_000;
  const key = await passphraseKey(passphrase, salt, iterations);
  const { nonce, ct } = await aeadEncrypt(key, plaintext, utf8('an1-keyfile'));
  return { salt: toB64u(salt), iterations, nonce, ct };
}

export async function decryptWithPassphrase(passphrase: string, box: { salt: string; iterations: number; nonce: string; ct: string }): Promise<Uint8Array> {
  const key = await passphraseKey(passphrase, fromB64u(box.salt), box.iterations);
  return aeadDecrypt(key, box.nonce, box.ct, utf8('an1-keyfile'));
}

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', buf(utf8(passphrase)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, 256));
}
