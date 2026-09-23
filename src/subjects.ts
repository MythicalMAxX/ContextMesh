/**
 * Subjects are the things agents ask about: endpoints ("GET /api/resources/{id}"), components
 * ("resource-service"), tasks ("UI-492") or free-form topics ("resource-details-api").
 * Every subject has a normalized key used for storage and matching.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const ENDPOINT_RE = /^\s*(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/\S*)\s*$/i;
const TASK_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export interface EndpointRef {
  method: string | null;
  path: string;
}

export function parseEndpoint(text: string): EndpointRef | null {
  const match = ENDPOINT_RE.exec(text);
  if (!match) return null;
  return { method: match[1] ? match[1].toUpperCase() : null, path: match[2]! };
}

/** Path parameters ({id}, :id, <id>) all normalize to "{}" so differently named params still match. */
export function normalizePath(path: string): string {
  let p = path.split(/[?#]/)[0]!.trim();
  p = p
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/(^|\/):[A-Za-z_][\w-]*/g, '$1{}')
    .replace(/<[^>]+>/g, '{}')
    .replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

export function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

export function subjectKey(subject: string): string {
  const endpoint = parseEndpoint(subject);
  if (endpoint) return endpoint.method ? endpointKey(endpoint.method, endpoint.path) : `* ${normalizePath(endpoint.path)}`;
  const trimmed = subject.trim();
  if (TASK_KEY_RE.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  return trimmed.toLowerCase().replace(/\s+/g, ' ');
}

export const isEndpointKey = (key: string): boolean => /^(?:[A-Z]+|\*) \//.test(key);
export const looksLikeTaskKey = (text: string): boolean => TASK_KEY_RE.test(text.trim());

function splitKey(key: string): [string, string] {
  const space = key.indexOf(' ');
  return [key.slice(0, space), key.slice(space + 1)];
}

function segmentsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === '{}' || b[i] === '{}' || seg === b[i]);
}

/** Does a stored endpoint key match a reference that may use concrete values ("/api/resources/123")? */
export function endpointMatches(key: string, ref: EndpointRef, options: { ignoreVersion?: boolean } = {}): boolean {
  const [method, path] = splitKey(key);
  if (ref.method && method !== '*' && ref.method !== method) return false;
  const strip = (segments: string[]) => (options.ignoreVersion ? segments.filter((s) => !/^v\d+$/i.test(s)) : segments);
  return segmentsMatch(strip(path.split('/')), strip(normalizePath(ref.path).split('/')));
}

/** Two endpoint keys refer to the same operation (a "*" method matches any method). */
export function endpointKeysMatch(a: string, b: string): boolean {
  if (!isEndpointKey(a) || !isEndpointKey(b)) return a === b;
  const [method, path] = splitKey(b);
  return endpointMatches(a, { method: method === '*' ? null : method, path });
}

// ---------------------------------------------------------------------------
// Lightweight lexical search (no external index; the catalog is small).
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'in', 'on', 'is', 'are', 'be', 'what', 'which', 'who',
  'how', 'does', 'do', 'can', 'api', 'apis', 'endpoint', 'current', 'with', 'by', 'from', 'this', 'that',
  'it', 'implement', 'page', 'v1', 'v2', 'v3',
]);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/** Fraction of query tokens present in the document. */
export function matchScore(query: string[], document: string[]): number {
  if (query.length === 0) return 0;
  const doc = new Set(document);
  const q = [...new Set(query)];
  return q.filter((t) => doc.has(t)).length / q.length;
}
