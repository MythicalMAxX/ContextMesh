import { aeadDecrypt, aeadEncrypt, canonicalJson, fromUtf8, randomBytes, randomId, seal, signJson, unseal, utf8, verifyJson } from '../../shared/crypto.ts';
import {
  TTL_HOURS,
  aadFor,
  sealContext,
  signedContent,
  validateHeader,
  type Envelope,
  type EnvelopeHeader,
  type Kind,
  type Priority,
  type SignedPayload,
} from '../../shared/protocol.ts';
import type { Member } from './directory.ts';
import type { Keys } from './identity.ts';

/**
 * Encrypts and signs a payload for a set of recipients:
 *  1. The payload is signed (Ed25519) together with the header, so authorship survives forwarding.
 *  2. The signed payload is encrypted with a fresh AES-256-GCM key; the header is the associated data.
 *  3. That key is sealed to each recipient's X25519 key (and the sender's, so it can read its own outbox).
 */
export async function sealEnvelope(
  keys: Keys,
  recipients: Member[],
  message: { kind: Kind; priority: Priority; payload: unknown; replyTo?: string | null; now: Date; ttlHours?: number },
): Promise<Envelope> {
  const ttl = Math.min(message.ttlHours ?? TTL_HOURS[message.priority], TTL_HOURS[message.priority]);
  const header: EnvelopeHeader = {
    v: 1,
    id: randomId('m'),
    org: keys.org,
    sender: keys.developer,
    audience: [...new Set(recipients.map((r) => r.id))].sort(),
    kind: message.kind,
    priority: message.priority,
    created_at: message.now.toISOString(),
    expires_at: new Date(message.now.getTime() + ttl * 3_600_000).toISOString(),
    reply_to: message.replyTo ?? null,
  };
  const sig = await signJson(keys.sign.private, signedContent(header, message.payload));
  const plaintext: SignedPayload = { payload: message.payload, sig };
  const contentKey = randomBytes(32);
  const { nonce, ct } = await aeadEncrypt(contentKey, utf8(canonicalJson(plaintext)), aadFor(header));
  const wrapFor = new Map<string, string>(recipients.map((r) => [r.id, r.box_pub]));
  wrapFor.set(keys.developer, keys.box.public);
  const sealed: Record<string, string> = {};
  for (const [member, boxPub] of wrapFor) sealed[member] = await seal(boxPub, contentKey, sealContext(header, member));
  return { header, keys: sealed, nonce, ct };
}

export class EnvelopeError extends Error {}

/** Decrypts an envelope addressed to us and verifies the sender's signature against the verified directory. */
export async function openEnvelope(
  keys: Keys,
  envelope: Envelope,
  lookupSender: (id: string) => Member | undefined,
  now: Date,
): Promise<{ header: EnvelopeHeader; payload: unknown; sender: Member }> {
  const { header } = envelope;
  const problem = validateHeader(header, keys.org, Date.parse(header?.created_at ?? '') || now.getTime());
  if (problem) throw new EnvelopeError(problem);
  const wrapped = envelope.keys?.[keys.developer];
  if (!wrapped) throw new EnvelopeError('envelope has no content key for this member');
  const sender = lookupSender(header.sender);
  if (!sender) throw new EnvelopeError(`unknown or unverified sender ${header.sender}`);
  let plaintext: SignedPayload;
  try {
    const contentKey = await unseal(keys.box.private, keys.box.public, wrapped, sealContext(header, keys.developer));
    plaintext = JSON.parse(fromUtf8(await aeadDecrypt(contentKey, envelope.nonce, envelope.ct, aadFor(header)))) as SignedPayload;
  } catch {
    throw new EnvelopeError('envelope could not be decrypted (tampered, or not encrypted for this member)');
  }
  if (!(await verifyJson(sender.sign_pub, signedContent(header, plaintext.payload), plaintext.sig))) {
    throw new EnvelopeError(`signature from ${header.sender} does not verify`);
  }
  return { header, payload: plaintext.payload, sender };
}
