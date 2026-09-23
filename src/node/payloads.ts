/**
 * Encrypted payloads carried inside envelopes. Senders are authenticated members, but payloads are still
 * validated: a buggy or compromised member must not be able to corrupt another member's graph.
 */
import { z } from 'zod';
import { FACT_LOCATIONS, FACT_PROPERTIES, SOURCE_KINDS } from '../types.ts';

const text = (max: number) => z.string().max(max);

export const SharedFactSchema = z.object({
  subject: text(300).optional(),
  field: text(200),
  property: z.enum(FACT_PROPERTIES),
  value: z.union([z.boolean(), text(500), z.array(text(200)).max(200)]),
  location: z.enum(FACT_LOCATIONS).optional(),
  source: z.enum(SOURCE_KINDS).optional(),
  evidence: text(500).optional(),
});

export const SharedEntrySchema = z.object({
  id: z.string().regex(/^ctx_[A-Za-z0-9_-]{6,40}$/),
  slot: text(600),
  subject: text(300),
  component_id: text(100).nullable(),
  type: text(60),
  title: text(1000).nullable(),
  data: z.unknown(),
  source_kind: z.enum(SOURCE_KINDS),
  source_ref: text(600).nullable(),
  commit: text(100).nullable(),
  generated_at: z.string().datetime(),
  verified_against: z.array(text(40)).max(10),
  impl_status: text(40).nullable(),
  tests: text(40).nullable(),
  agent: text(100).nullable(),
  facts: z.array(SharedFactSchema).max(2000),
});
export type SharedEntry = z.infer<typeof SharedEntrySchema>;

export const SharedTaskSchema = z.object({
  key: text(60),
  source: text(200),
  title: text(1000).nullable(),
  description: text(20_000).nullable(),
  status: text(100).nullable(),
  url: text(1000).nullable(),
  component_id: text(100).nullable(),
  assignee: text(200).nullable(),
  labels: z.array(text(100)).max(50),
  updated_at: text(60).nullable(),
});

export const SettlementSchema = z.object({
  fingerprint: text(128).nullable(),
  conflict_ref: text(128),
  component: text(100).nullable(),
  subject: text(300),
  field: text(200).nullable(),
  property: text(40).nullable(),
  location: text(20).nullable(),
  resolution: text(5000),
  correct_value: z.unknown().optional(),
  outdated_sources: z.array(text(300)).max(50).optional(),
  follow_up: z.array(text(500)).max(50).optional(),
  decided_by: z.enum(['agent', 'human']),
});

export const GraphUpdateSchema = z.object({
  entries: z.array(SharedEntrySchema).max(5000).default([]),
  retired: z.array(z.object({ id: text(60), component_id: text(100).nullable() })).max(5000).default([]),
  reconfirmed: z.array(z.object({ id: text(60), commit: text(100).nullable(), generated_at: z.string().datetime() })).max(5000).default([]),
  tasks: z.array(SharedTaskSchema).max(2000).default([]),
  repositories: z.array(z.object({ id: text(100), head_commit: text(100).nullable(), indexed_at: text(60).nullable() })).max(200).default([]),
  settlements: z.array(SettlementSchema).max(500).default([]),
});
export type GraphUpdate = z.infer<typeof GraphUpdateSchema>;

export const EnquirySchema = z.object({
  question: text(10_000),
  subject: text(300).nullable(),
  component: text(100),
  details: z.record(z.string(), z.unknown()).nullable().default(null),
  agent: text(100),
  requester_component: text(100).nullable(),
  requester_repository: text(200).nullable().default(null),
});
export type Enquiry = z.infer<typeof EnquirySchema>;

export const AnswerSchema = z.object({
  status: z.enum(['answered', 'declined', 'escalated']),
  answer: text(50_000),
  evidence: z.array(text(1000)).max(100).default([]),
  confidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
  agent: text(100),
  auto: z.object({ responder: text(200) }).nullable().default(null),
  decided_by_human: z.boolean().default(false),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const ConflictReportSchema = z.object({
  subject: text(300),
  field: text(200).optional(),
  property: text(40).optional(),
  location: text(20).optional(),
  description: text(5000),
  sources: z.array(z.object({ source: text(100), value: z.unknown(), ref: text(600).nullable().optional(), component: text(100).nullable().optional() })).min(2).max(50),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  component: text(100),
  agent: text(100),
});

export const ChangeNoticeSchema = z.object({
  subject: text(300),
  component: text(100),
  title: text(300),
  summary: text(10_000),
  doc: text(200_000).nullable().default(null),
  changes: z.array(z.object({ severity: text(40), location: text(20), field: text(200).optional(), change: text(500), old: z.unknown().optional(), new: z.unknown().optional() })).max(500).default([]),
  action_required: z.boolean(),
  breaking: z.boolean().default(false),
  /** Optional knowledge to add to the recipient's graph memory once their developer approves. */
  entries: z.array(SharedEntrySchema).max(100).default([]),
  agent: text(100),
});
export type ChangeNotice = z.infer<typeof ChangeNoticeSchema>;

export const ReceiptSchema = z.object({
  item: text(100),
  decision: z.enum(['approved', 'rejected', 'deferred', 'done']),
  note: text(5000).nullable().default(null),
  component: text(100).nullable().default(null),
});

export const ManifestPayloadSchema = z.object({ version: z.number().int().positive(), manifest: z.unknown() });

export const SnapshotSchema = z.object({
  snapshot_id: text(60),
  part: z.number().int().nonnegative(),
  parts: z.number().int().positive(),
  graph: GraphUpdateSchema,
});
