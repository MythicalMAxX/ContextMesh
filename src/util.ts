import { createHash, randomBytes } from 'node:crypto';

export const toJson = (value: unknown): string => JSON.stringify(value ?? null);

export function fromJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const randomToken = (prefix: string, bytes = 24): string => `${prefix}${randomBytes(bytes).toString('base64url')}`;

export const iso = (date: Date): string => date.toISOString();

export const addHours = (date: Date, hours: number): Date => new Date(date.getTime() + hours * 3_600_000);

export function ageLabel(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

/** Short commit hashes and full hashes refer to the same commit when one is a prefix of the other. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** Deterministic JSON (sorted keys) so content hashes don't depend on key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
