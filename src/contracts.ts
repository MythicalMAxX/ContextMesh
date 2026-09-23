import { HTTP_METHODS } from './subjects.ts';
import type { Contract, FactInput, FactLocation, FactProperty, FieldSpec, ResponseSpec } from './types.ts';

// ---------------------------------------------------------------------------
// OpenAPI (3.x, with basic Swagger 2 support) -> normalized contracts
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

const MAX_FIELD_DEPTH = 2;

function resolveRef(doc: Json, node: any, seen = new Set<string>()): any {
  let current = node;
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const ref: string = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    seen.add(ref);
    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<any>((acc, part) => (acc == null ? acc : acc[part]), doc);
  }
  return current ?? {};
}

function typeOf(doc: Json, schema: any): string | undefined {
  const s = resolveRef(doc, schema);
  const types = (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []).filter((t: string) => t !== 'null');
  if (types[0] === 'array') {
    const items = typeOf(doc, s.items);
    return items ? `array<${items}>` : 'array';
  }
  if (types.length) return types.join('|');
  if (s.properties || s.allOf) return 'object';
  if (schema?.$ref) return String(schema.$ref).split('/').pop();
  return undefined;
}

function isNullable(doc: Json, schema: any): boolean {
  const s = resolveRef(doc, schema);
  if (s.nullable === true) return true;
  if (Array.isArray(s.type) && s.type.includes('null')) return true;
  const variants = [...(s.anyOf ?? []), ...(s.oneOf ?? [])];
  return variants.some((v: any) => {
    const r = resolveRef(doc, v);
    return r.type === 'null' || (Array.isArray(r.type) && r.type.includes('null'));
  });
}

function enumOf(doc: Json, schema: any): string[] | undefined {
  const s = resolveRef(doc, schema);
  const values = s.enum ?? (s.const !== undefined ? [s.const] : undefined);
  const fromVariants = [...(s.anyOf ?? []), ...(s.oneOf ?? [])]
    .map((v: any) => resolveRef(doc, v))
    .flatMap((v: any) => v.enum ?? []);
  const all = [...(values ?? []), ...fromVariants].filter((v) => v !== null).map(String);
  return all.length ? all : undefined;
}

function fieldSpec(doc: Json, schema: any, required: boolean): FieldSpec {
  const s = resolveRef(doc, schema);
  const spec: FieldSpec = { required };
  const type = typeOf(doc, schema);
  if (type) spec.type = type;
  if (isNullable(doc, schema)) spec.nullable = true;
  else spec.nullable = false;
  const values = enumOf(doc, schema);
  if (values) spec.enum = values;
  if (s.format) spec.format = String(s.format);
  if (s.description) spec.description = String(s.description).trim();
  return spec;
}

/** Merges allOf / oneOf / anyOf into a flat list of properties and required names. */
function objectShape(doc: Json, schema: any, seen = new Set<any>()): { properties: Record<string, any>; required: Set<string> } {
  const s = resolveRef(doc, schema);
  const properties: Record<string, any> = {};
  const required = new Set<string>();
  if (!s || typeof s !== 'object' || seen.has(s)) return { properties, required };
  seen.add(s);
  for (const part of s.allOf ?? []) {
    const inner = objectShape(doc, part, seen);
    Object.assign(properties, inner.properties);
    inner.required.forEach((r) => required.add(r));
  }
  // Properties that only exist in some variants of a oneOf/anyOf are never guaranteed.
  for (const part of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) {
    const inner = objectShape(doc, part, seen);
    for (const [name, prop] of Object.entries(inner.properties)) properties[name] ??= prop;
  }
  Object.assign(properties, s.properties ?? {});
  for (const name of s.required ?? []) required.add(name);
  return { properties, required };
}

function flattenFields(doc: Json, schema: any, prefix = '', depth = 0, out: Record<string, FieldSpec> = {}): Record<string, FieldSpec> {
  const s = resolveRef(doc, schema);
  if (depth >= MAX_FIELD_DEPTH) return out;
  if (typeOf(doc, s)?.startsWith('array') && s.items && !prefix) {
    return flattenFields(doc, s.items, '[]', depth, out);
  }
  const { properties, required } = objectShape(doc, s);
  for (const [name, prop] of Object.entries(properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    out[key] = fieldSpec(doc, prop, required.has(name));
    const resolved = resolveRef(doc, prop);
    if (resolved.properties || resolved.allOf) flattenFields(doc, resolved, key, depth + 1, out);
    else if (resolved.items && resolveRef(doc, resolved.items).properties) {
      flattenFields(doc, resolved.items, `${key}[]`, depth + 1, out);
    }
  }
  return out;
}

function jsonSchemaOf(doc: Json, content: any): { contentType?: string; schema?: any; example?: any } {
  if (!content || typeof content !== 'object') return {};
  const type = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content)[0];
  if (!type) return {};
  const media = resolveRef(doc, content[type]);
  const example = media.example ?? Object.values(media.examples ?? {}).map((e: any) => resolveRef(doc, e).value)[0];
  return { contentType: type, schema: media.schema, example };
}

const ERROR_CODE_FIELDS = ['error', 'code', 'error_code', 'errorCode'];

function errorCodes(doc: Json, schema: any, example: any): string[] {
  const codes = new Set<string>();
  if (schema) {
    const { properties } = objectShape(doc, schema);
    for (const field of ERROR_CODE_FIELDS) {
      for (const value of properties[field] ? (enumOf(doc, properties[field]) ?? []) : []) codes.add(value);
      const nested = properties[field] ? objectShape(doc, properties[field]).properties : {};
      for (const inner of ['code', 'type']) for (const value of nested[inner] ? (enumOf(doc, nested[inner]) ?? []) : []) codes.add(value);
    }
  }
  if (example && typeof example === 'object') {
    for (const field of ERROR_CODE_FIELDS) {
      const value = example[field];
      if (typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value)) codes.add(value);
      if (value && typeof value === 'object' && typeof value.code === 'string') codes.add(value.code);
    }
  }
  return [...codes];
}

function describeAuth(doc: Json, requirements: any[] | undefined): string[] | undefined {
  if (!Array.isArray(requirements)) return undefined;
  if (requirements.length === 0) return ['none'];
  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const names = new Set<string>();
  for (const requirement of requirements) {
    const keys = Object.keys(requirement ?? {});
    if (keys.length === 0) names.add('optional');
    for (const name of keys) {
      const scheme = resolveRef(doc, schemes[name]);
      if (scheme.type === 'http') names.add(String(scheme.scheme ?? 'http').toLowerCase());
      else if (scheme.type === 'apiKey') names.add(`api_key (${scheme.in ?? '?'}: ${scheme.name ?? name})`);
      else if (scheme.type) names.add(String(scheme.type));
      else names.add(name);
    }
  }
  return [...names];
}

export interface ParsedOpenApi {
  title: string | null;
  version: string | null;
  contracts: Contract[];
}

export function parseOpenApi(doc: Json): ParsedOpenApi {
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger) || typeof doc.paths !== 'object') {
    throw new Error('not an OpenAPI/Swagger document');
  }
  const contracts: Contract[] = [];
  const basePath = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/+$/, '') : '';
  for (const [path, rawItem] of Object.entries<any>(doc.paths ?? {})) {
    const item = resolveRef(doc, rawItem);
    for (const method of HTTP_METHODS) {
      const op = item[method.toLowerCase()];
      if (!op) continue;
      const contract: Contract = { method, path: `${basePath}${path}` };
      if (op.summary) contract.summary = String(op.summary);
      if (op.operationId) contract.operation_id = String(op.operationId);
      const auth = describeAuth(doc, op.security ?? doc.security);
      if (auth) contract.auth = auth;

      const params: Record<string, FieldSpec> = {};
      let bodySchema: any;
      for (const rawParam of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const param = resolveRef(doc, rawParam);
        if (param.in === 'body') {
          bodySchema = param.schema; // Swagger 2
          continue;
        }
        if (!param.name) continue;
        const spec = fieldSpec(doc, param.schema ?? param, param.in === 'path' ? true : param.required === true);
        spec.in = param.in;
        if (param.description) spec.description = String(param.description).trim();
        params[param.name] = spec;
      }
      if (Object.keys(params).length) contract.params = params;

      const body = op.requestBody ? resolveRef(doc, op.requestBody) : undefined;
      const { contentType, schema } = body ? jsonSchemaOf(doc, body.content) : { contentType: undefined, schema: bodySchema };
      if (schema) contract.request = { ...(contentType ? { content_type: contentType } : {}), fields: flattenFields(doc, schema) };

      const responses: Record<string, ResponseSpec> = {};
      const errors = new Set<string>();
      for (const [status, rawResponse] of Object.entries<any>(op.responses ?? {})) {
        const response = resolveRef(doc, rawResponse);
        const media = response.content ? jsonSchemaOf(doc, response.content) : { schema: response.schema };
        const spec: ResponseSpec = {};
        if (response.description) spec.description = String(response.description);
        if (media.schema) {
          const fields = flattenFields(doc, media.schema);
          if (Object.keys(fields).length) spec.fields = fields;
        }
        if (!status.startsWith('2')) {
          const codes = errorCodes(doc, media.schema, media.example);
          if (codes.length) spec.error_codes = codes;
          codes.forEach((c) => errors.add(c));
        }
        responses[status] = spec;
      }
      if (Object.keys(responses).length) contract.responses = responses;
      if (errors.size) contract.errors = [...errors];
      contracts.push(contract);
    }
  }
  return { title: doc.info?.title ?? null, version: doc.info?.version ?? null, contracts };
}

// ---------------------------------------------------------------------------
// Facts: flatten a contract into comparable claims
// ---------------------------------------------------------------------------

export function successResponse(contract: Contract): ResponseSpec | undefined {
  const statuses = Object.keys(contract.responses ?? {}).sort();
  const status = statuses.find((s) => s.startsWith('2')) ?? statuses.find((s) => s === 'default');
  return status ? contract.responses![status] : undefined;
}

function fieldFacts(fields: Record<string, FieldSpec> | undefined, location: FactLocation): FactInput[] {
  const facts: FactInput[] = [];
  for (const [field, spec] of Object.entries(fields ?? {})) {
    if (typeof spec !== 'object' || spec === null) continue;
    if (typeof spec.required === 'boolean') facts.push({ field, property: 'required', value: spec.required, location });
    if (typeof spec.nullable === 'boolean') facts.push({ field, property: 'nullable', value: spec.nullable, location });
    if (typeof spec.type === 'string') facts.push({ field, property: 'type', value: spec.type, location });
    if (Array.isArray(spec.enum) && spec.enum.length) facts.push({ field, property: 'enum', value: spec.enum.map(String), location });
  }
  return facts;
}

/** Converts a normalized contract (from OpenAPI or published by an agent) into facts. */
export function contractFacts(contract: Contract): FactInput[] {
  return [
    ...fieldFacts(contract.params, 'request'),
    ...fieldFacts(contract.request?.fields, 'request'),
    ...fieldFacts(successResponse(contract)?.fields, 'response'),
  ];
}

export function normalizeFactValue(property: FactProperty, value: unknown): string {
  if (property === 'enum') {
    const values = Array.isArray(value) ? value : String(value).split(/[,|]/);
    return [...new Set(values.map((v) => String(v).trim().toLowerCase()).filter(Boolean))].sort().join('|');
  }
  if (property === 'required' || property === 'nullable') {
    return String(value === true || value === 'true');
  }
  return String(value).trim().toLowerCase();
}

export function describeFactValue(property: FactProperty, value: unknown): string {
  switch (property) {
    case 'required':
      return value === true || value === 'true' ? 'required' : 'optional';
    case 'nullable':
      return value === true || value === 'true' ? 'nullable' : 'not nullable';
    case 'enum':
      return `one of [${(Array.isArray(value) ? value : [value]).join(', ')}]`;
    case 'type':
      return `type ${String(value)}`;
  }
}

// ---------------------------------------------------------------------------
// Contract diff for pre-deployment impact analysis
// ---------------------------------------------------------------------------

export type ChangeSeverity = 'breaking' | 'potentially_breaking' | 'non_breaking';

export interface ContractChange {
  severity: ChangeSeverity;
  location: 'request' | 'response' | 'endpoint';
  field?: string;
  change: string;
  old?: unknown;
  new?: unknown;
}

type FieldMap = Map<string, FieldSpec>;

function fieldMap(contract: Contract, location: 'request' | 'response'): FieldMap {
  const map: FieldMap = new Map();
  if (location === 'request') {
    for (const [name, spec] of Object.entries(contract.params ?? {})) map.set(name, spec);
    for (const [name, spec] of Object.entries(contract.request?.fields ?? {})) map.set(name, spec);
  } else {
    for (const [name, spec] of Object.entries(successResponse(contract)?.fields ?? {})) map.set(name, spec);
  }
  return map;
}

const lower = (values: string[] | undefined) => new Set((values ?? []).map((v) => v.toLowerCase()));

function diffFields(location: 'request' | 'response', before: FieldMap, after: FieldMap): ContractChange[] {
  const changes: ContractChange[] = [];
  const req = location === 'request';
  const add = (severity: ChangeSeverity, field: string, change: string, oldValue?: unknown, newValue?: unknown) =>
    changes.push({ severity, location, field, change, ...(oldValue !== undefined ? { old: oldValue } : {}), ...(newValue !== undefined ? { new: newValue } : {}) });

  for (const [field, spec] of after) {
    if (!before.has(field)) {
      if (req && spec.required) add('breaking', field, 'new required request field');
      else add('non_breaking', field, `new ${location} field`);
    }
  }
  for (const [field, old] of before) {
    const now = after.get(field);
    if (!now) {
      add(req ? 'potentially_breaking' : 'breaking', field, `${location} field removed`);
      continue;
    }
    if (!!old.required !== !!now.required) {
      if (req) add(now.required ? 'breaking' : 'non_breaking', field, now.required ? 'optional → required' : 'required → optional', old.required, now.required);
      else add(now.required ? 'non_breaking' : 'potentially_breaking', field, now.required ? 'now always present' : 'may now be absent', old.required, now.required);
    }
    if (!!old.nullable !== !!now.nullable) {
      if (req) add(now.nullable ? 'non_breaking' : 'breaking', field, now.nullable ? 'now accepts null' : 'no longer accepts null');
      else add(now.nullable ? 'breaking' : 'non_breaking', field, now.nullable ? 'may now be null' : 'no longer null');
    }
    if (old.type && now.type && old.type.toLowerCase() !== now.type.toLowerCase()) {
      add('breaking', field, 'type changed', old.type, now.type);
    }
    const oldEnum = lower(old.enum);
    const newEnum = lower(now.enum);
    if (oldEnum.size === 0 && newEnum.size > 0) {
      add(req ? 'breaking' : 'potentially_breaking', field, 'now restricted to an enum', undefined, now.enum);
    } else if (oldEnum.size > 0 && newEnum.size === 0) {
      add(req ? 'non_breaking' : 'potentially_breaking', field, 'enum restriction removed', old.enum, undefined);
    } else {
      const added = [...newEnum].filter((v) => !oldEnum.has(v));
      const removed = [...oldEnum].filter((v) => !newEnum.has(v));
      if (added.length) add(req ? 'non_breaking' : 'potentially_breaking', field, `enum values added: ${added.join(', ')}`, old.enum, now.enum);
      if (removed.length) add(req ? 'breaking' : 'non_breaking', field, `enum values removed: ${removed.join(', ')}`, old.enum, now.enum);
    }
  }
  return changes;
}

export function diffContracts(before: Contract, after: Contract): ContractChange[] {
  const changes = [
    ...diffFields('request', fieldMap(before, 'request'), fieldMap(after, 'request')),
    ...diffFields('response', fieldMap(before, 'response'), fieldMap(after, 'response')),
  ];
  const oldAuth = (before.auth ?? []).join(',');
  const newAuth = (after.auth ?? []).join(',');
  if (oldAuth !== newAuth && before.auth && after.auth) {
    changes.push({ severity: 'potentially_breaking', location: 'endpoint', change: 'authentication changed', old: before.auth, new: after.auth });
  }
  const oldStatuses = Object.keys(before.responses ?? {}).filter((s) => s.startsWith('2'));
  const newStatuses = Object.keys(after.responses ?? {}).filter((s) => s.startsWith('2'));
  if (oldStatuses.length && newStatuses.length && oldStatuses.join() !== newStatuses.join()) {
    changes.push({ severity: 'potentially_breaking', location: 'endpoint', change: 'success status changed', old: oldStatuses, new: newStatuses });
  }
  const oldErrors = new Set(before.errors ?? []);
  const addedErrors = (after.errors ?? []).filter((e) => !oldErrors.has(e));
  if (addedErrors.length) {
    changes.push({ severity: 'non_breaking', location: 'endpoint', change: `new error codes: ${addedErrors.join(', ')}` });
  }
  return changes;
}

export function describeChange(change: ContractChange): string {
  const where = change.field ? `${change.location} field \`${change.field}\`` : change.location;
  const values =
    change.old !== undefined || change.new !== undefined
      ? ` (${JSON.stringify(change.old ?? null)} → ${JSON.stringify(change.new ?? null)})`
      : '';
  return `[${change.severity}] ${where}: ${change.change}${values}`;
}

/** Accepts either a normalized contract or a loose agent-published shape and returns a normalized contract. */
export function coerceContract(data: unknown, method: string | null, path: string | null): Contract | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, any>;
  const m = (typeof d.method === 'string' ? d.method : method)?.toUpperCase();
  const p = typeof d.path === 'string' ? d.path : path;
  if (!m || !p) return null;
  const contract: Contract = { ...d, method: m, path: p };
  // Allow the simpler "response": { fields } shape used in hand-written contracts.
  if (!d.responses && d.response && typeof d.response === 'object') {
    contract.responses = { '200': d.response.fields ? d.response : { fields: d.response } };
    delete contract.response;
  }
  if (d.request && typeof d.request === 'object' && !d.request.fields) contract.request = { fields: d.request };
  if (typeof d.auth === 'string') contract.auth = [d.auth];
  return contract;
}
