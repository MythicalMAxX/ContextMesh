import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Params = Record<string, SQLInputValue | boolean | undefined>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- Registry (synced from configuration; CODEOWNERS adds owners during indexing)
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT, github_team TEXT, notify TEXT);
CREATE TABLE IF NOT EXISTS developers (id TEXT PRIMARY KEY, name TEXT, email TEXT, github TEXT, admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, developer_id TEXT NOT NULL, PRIMARY KEY (team_id, developer_id));
CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, description TEXT, repository_id TEXT, path TEXT,
  visibility TEXT NOT NULL DEFAULT 'org'
);
CREATE TABLE IF NOT EXISTS component_owners (
  component_id TEXT NOT NULL, developer_id TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (component_id, developer_id, source)
);
CREATE TABLE IF NOT EXISTS component_aliases (alias TEXT PRIMARY KEY COLLATE NOCASE, component_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS component_readers (component_id TEXT NOT NULL, team_id TEXT NOT NULL, PRIMARY KEY (component_id, team_id));
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, location TEXT NOT NULL, branch TEXT, head_commit TEXT, indexed_at TEXT, index_error TEXT
);
CREATE TABLE IF NOT EXISTS path_owners (
  repository_id TEXT NOT NULL, position INTEGER NOT NULL, pattern TEXT NOT NULL, owners TEXT NOT NULL,
  PRIMARY KEY (repository_id, position)
);
CREATE TABLE IF NOT EXISTS presence (
  developer_id TEXT NOT NULL, agent TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '', component_id TEXT,
  last_seen TEXT NOT NULL, PRIMARY KEY (developer_id, agent, repository)
);

-- Tasks from Jira / Linear / files
CREATE TABLE IF NOT EXISTS tasks (
  key TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, description TEXT, status TEXT, url TEXT,
  component_id TEXT, assignee TEXT, labels TEXT NOT NULL DEFAULT '[]', updated_at TEXT, indexed_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'local', shared INTEGER NOT NULL DEFAULT 0
);

-- Context: versioned knowledge with provenance
CREATE TABLE IF NOT EXISTS context_entries (
  id TEXT PRIMARY KEY, slot TEXT NOT NULL, subject TEXT NOT NULL, subject_key TEXT NOT NULL, subject_kind TEXT NOT NULL,
  component_id TEXT, type TEXT NOT NULL, title TEXT, data TEXT NOT NULL, content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL, source_ref TEXT, commit_sha TEXT, generated_at TEXT NOT NULL,
  published_by TEXT, verified_against TEXT NOT NULL DEFAULT '[]', impl_status TEXT, tests TEXT,
  status TEXT NOT NULL DEFAULT 'current', supersedes TEXT,
  -- 'local' for knowledge produced on this machine, otherwise the member id it was received from
  origin TEXT NOT NULL DEFAULT 'local', shared INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS context_unshared ON context_entries (origin, shared);
CREATE INDEX IF NOT EXISTS context_subject ON context_entries (subject_key, status);
CREATE INDEX IF NOT EXISTS context_slot ON context_entries (slot, status);
CREATE INDEX IF NOT EXISTS context_component ON context_entries (component_id, status);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, subject_key TEXT NOT NULL,
  field TEXT NOT NULL, property TEXT NOT NULL, location TEXT NOT NULL, value TEXT NOT NULL,
  source_kind TEXT NOT NULL, evidence TEXT
);
CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject_key);
CREATE INDEX IF NOT EXISTS facts_entry ON facts (entry_id);

-- Context graph
CREATE TABLE IF NOT EXISTS edges (
  from_kind TEXT NOT NULL, from_id TEXT NOT NULL, rel TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (from_kind, from_id, rel, to_kind, to_id, source)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_kind, to_id, rel);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, subject_key TEXT NOT NULL, field TEXT, property TEXT, location TEXT,
  description TEXT NOT NULL, sources TEXT NOT NULL, confidence TEXT NOT NULL, component_id TEXT,
  state TEXT NOT NULL, fingerprint TEXT, origin TEXT NOT NULL, reported_by TEXT,
  request_id TEXT, escalation_id TEXT, resolution TEXT, resolved_value TEXT, follow_up TEXT, resolved_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS conflicts_subject ON conflicts (subject_key, state);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT, actor_developer TEXT, action TEXT NOT NULL,
  subject TEXT, request_id TEXT, conflict_id TEXT, details TEXT
);
CREATE INDEX IF NOT EXISTS audit_request ON audit_log (request_id);

-- Local node: verified member directory, message processing, and the developer-facing queue
CREATE TABLE IF NOT EXISTS node_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]', fingerprint TEXT NOT NULL, verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_messages (
  id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, sender TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, priority TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT, component_id TEXT,
  payload TEXT NOT NULL, state TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL, received_at TEXT NOT NULL,
  expires_at TEXT, handled_at TEXT, handled_by TEXT, decision TEXT, note TEXT, auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_state ON inbox (state, priority);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, priority TEXT NOT NULL, audience TEXT NOT NULL, subject TEXT, component_id TEXT,
  payload TEXT NOT NULL, envelope TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, seq INTEGER,
  online TEXT, error TEXT, replies TEXT NOT NULL DEFAULT '[]', expires_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_state ON outbox (state);

-- Observer node (experiments): plaintext copy of every message addressed to it
CREATE TABLE IF NOT EXISTS trace (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, observed_at TEXT NOT NULL,
  sender TEXT NOT NULL, audience TEXT NOT NULL, kind TEXT NOT NULL, priority TEXT NOT NULL, reply_to TEXT,
  component_id TEXT, payload TEXT NOT NULL
);
`;

function bind(params: Params): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return out;
}

/** Thin synchronous wrapper around node:sqlite with statement caching and nested transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params: Params = {}): void {
    this.statement(sql).run(bind(params));
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.statement(sql).get(bind(params)) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.statement(sql).all(bind(params)) as T[];
  }

  /** Runs fn atomically. Nested calls use savepoints, so domain functions can compose freely. */
  tx<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      if (this.depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  /** Human-readable sequential ids such as REQ-12 or CONF-3. */
  nextId(prefix: string): string {
    this.run(
      'INSERT INTO counters (name, value) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1',
      { name: prefix },
    );
    const row = this.get<{ value: number }>('SELECT value FROM counters WHERE name = :name', { name: prefix });
    return `${prefix}-${row!.value}`;
  }

  close(): void {
    this.raw.close();
  }
}
