/**
 * Secret scanning. It runs on text an agent is about to send (questions, answers, published context) and on the files copied
 * into a scoped answering folder. It is a safety net with a short list of high-confidence patterns, not a guarantee: a secret in an
 * unusual shape gets through, which is why scoped answers also exclude files by name and why a human approves anything sensitive.
 */
export interface SecretHit {
  kind: string;
  /** A few characters, never the whole value. */
  sample: string;
}

const PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: 'private key block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'API key (sk-...)', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'Stripe live key', regex: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { kind: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'JSON web token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: 'password inside a URL', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{3,}@[^\s/]+/i },
];

// `password: value`, `API_KEY=value`, `"token": "value"`. The value must look like a secret (long enough, with a digit or a symbol),
// so documentation such as `token: string` or `password: required` is not flagged.
const ASSIGNMENT = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token)\b["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi;
const looksLikeSecretValue = (value: string): boolean => /[0-9]/.test(value) || /[-_!@#$%^&*]/.test(value);
const PLACEHOLDER = /^(?:<|\$|\{\{|\[REDACTED|your[-_]|xxx|\*{3,}|changeme|example|placeholder|todo)/i;

const sample = (value: string): string => `${value.slice(0, 4)}…`;

export function findSecrets(text: string, canaries: readonly string[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { kind, regex } of PATTERNS) {
    const match = regex.exec(text);
    if (match) hits.push({ kind, sample: sample(match[0]) });
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1]!;
    if (!PLACEHOLDER.test(value) && looksLikeSecretValue(value)) {
      hits.push({ kind: 'secret assignment', sample: sample(value) });
      break;
    }
  }
  for (const canary of canaries) if (canary && text.includes(canary)) hits.push({ kind: 'configured canary string', sample: sample(canary) });
  return hits;
}

export function redactSecrets(text: string, canaries: readonly string[] = []): { text: string; hits: SecretHit[] } {
  const hits = findSecrets(text, canaries);
  if (hits.length === 0) return { text, hits };
  let out = text;
  for (const { regex } of PATTERNS) out = out.replace(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`), '[REDACTED]');
  out = out.replace(ASSIGNMENT, (whole, value: string) => (!PLACEHOLDER.test(value) && looksLikeSecretValue(value) ? whole.replace(value, '[REDACTED]') : whole));
  for (const canary of canaries) if (canary) out = out.split(canary).join('[REDACTED]');
  return { text: out, hits };
}

/** One sentence for the agent that tried to send the text. */
export function describeHits(hits: SecretHit[]): string {
  const kinds = [...new Set(hits.map((hit) => hit.kind))].join(', ');
  return `The text contains what looks like a secret or credential (${kinds}), so it was not sent. Remove it and describe it instead (for example "the API key in .env"), or ask your developer to share it through a channel meant for secrets.`;
}

const SECRET_FILE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^\.(?:npmrc|netrc|pypirc|git-credentials)$/i,
  /^credentials(?:\..+)?$/i,
  /^secrets?(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^service[-_]account.*\.json$/i,
];
const SAFE_ENV_TEMPLATES = /^\.env\.(?:example|sample|template|dist)$/i;

/** True for files that are secrets by name; they are never copied into a scoped answering folder. */
export function looksLikeSecretFile(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const name = segments[segments.length - 1]!;
  if (SAFE_ENV_TEMPLATES.test(name)) return false;
  return segments.includes('.git') || SECRET_FILE_NAMES.some((pattern) => pattern.test(name));
}
