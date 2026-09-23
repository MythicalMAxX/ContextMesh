import type { Config } from './config.ts';
import type { Db } from './db.ts';

/** Where a piece of engineering knowledge came from. Different sources represent different kinds of truth. */
export const SOURCE_KINDS = ['openapi', 'code', 'tests', 'doc', 'pr', 'task', 'chat', 'agent', 'human'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Sources that describe what the system actually does or what a human decided, as opposed to intent or hearsay. */
export const AUTHORITATIVE_SOURCES: ReadonlySet<string> = new Set(['openapi', 'code', 'tests', 'human']);

/** Who is making a call: the developer (from the token) plus the agent context (from headers). */
export interface Identity {
  developer: string;
  name: string | null;
  teams: string[];
  admin: boolean;
  /** Agent product, e.g. "claude-code", "codex", "cursor". */
  agent: string;
  repository: string | null;
  /** Component the agent is working on, from the X-Component header or inferred from the repository. */
  component: string | null;
  task: string | null;
}

export const SYSTEM_IDENTITY: Identity = {
  developer: 'system',
  name: 'agent-network',
  teams: [],
  admin: true,
  agent: 'agent-network',
  repository: null,
  component: null,
  task: null,
};

export interface Ctx {
  db: Db;
  /** Replaced when a newer signed manifest arrives. */
  config: Config;
  now(): Date;
  log(message: string): void;
}

// ---------------------------------------------------------------------------
// Contracts: a provider-neutral, normalized view of an API operation.
// The OpenAPI indexer produces these, and agents may publish them directly.
// ---------------------------------------------------------------------------

export interface FieldSpec {
  type?: string;
  required?: boolean;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  description?: string;
  /** For parameters: path, query, header or cookie. */
  in?: string;
}

export interface ResponseSpec {
  description?: string;
  fields?: Record<string, FieldSpec>;
  error_codes?: string[];
}

export interface Contract {
  method: string;
  path: string;
  summary?: string;
  operation_id?: string;
  auth?: string[];
  params?: Record<string, FieldSpec>;
  request?: { content_type?: string; fields: Record<string, FieldSpec> };
  responses?: Record<string, ResponseSpec>;
  errors?: string[];
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Facts: atomic, comparable claims used for conflict detection.
// ---------------------------------------------------------------------------

export const FACT_PROPERTIES = ['required', 'nullable', 'type', 'enum'] as const;
export type FactProperty = (typeof FACT_PROPERTIES)[number];

export const FACT_LOCATIONS = ['request', 'response', '*'] as const;
export type FactLocation = (typeof FACT_LOCATIONS)[number];

export type FactValue = boolean | string | string[];

export interface FactInput {
  /** Subject the fact is about; defaults to the subject of the entry that carries it. */
  subject?: string;
  field: string;
  property: FactProperty;
  value: FactValue;
  /** "*" means the source did not say whether it is about the request or the response. */
  location?: FactLocation;
  source?: SourceKind;
  /** Where the claim can be verified, e.g. "resource.go:219" or "openapi.yaml#/paths/...". */
  evidence?: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';
