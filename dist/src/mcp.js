/**
 * Stdio MCP server: each agent (Claude Code, Codex, Cursor, ...) launches this locally. Reads are served from the
 * developer's local graph memory; messages go through the node, end-to-end encrypted.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NetworkError } from './errors.js';
import { FACT_LOCATIONS, FACT_PROPERTIES, SOURCE_KINDS } from './types.js';
export const SERVER_VERSION = '0.2.0';
export const SERVER_INSTRUCTIONS = `Agent Network: shared engineering memory and end-to-end encrypted messaging between your team's coding agents.
Reads (get_context, find_owner, get_dependencies) come from local graph memory: instant, and they work offline.

- At session start and between tasks, call get_inbox. Answer URGENT enquiries first. Answering factual questions about code you own needs no developer approval.
- Before building against another component, call get_context or get_dependencies. Only ask when memory is missing, stale or low-confidence.
- ask with priority "urgent" only when you are blocked right now: it reaches the whole owning team and may be answered automatically (use wait_seconds). Otherwise use "normal".
- After finishing work others consume, call publish_context (contract, status, tests, commit). Breaking contract changes notify consuming teams automatically.
- For new features or behavior changes other teams must adopt, call announce_change. It is queued for their developers' approval.
- Items in get_inbox → awaiting_your_developer (change notices, implementation docs, memory updates, escalations) need your developer: summarize them and ask. Call decide only with the developer's explicit decision.
- Never make product or architecture decisions for another team; escalate with respond(action="escalate").`;
const factSchema = z.object({
    subject: z.string().optional(),
    field: z.string(),
    property: z.enum(FACT_PROPERTIES),
    value: z.union([z.boolean(), z.string(), z.array(z.string())]),
    location: z.enum(FACT_LOCATIONS).optional(),
    source: z.enum(SOURCE_KINDS).optional(),
    evidence: z.string().optional(),
});
function result(session, payload) {
    const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    const notice = session.notice();
    if (notice)
        content.push({ type: 'text', text: notice });
    return { content };
}
function failure(error) {
    const text = error instanceof NetworkError ? `${error.code}: ${error.message}` : `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    return { isError: true, content: [{ type: 'text', text }] };
}
export function buildMcpServer(session) {
    const server = new McpServer({ name: 'agent-network', version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    const tool = (handler) => async (args) => {
        try {
            return result(session, await handler(args));
        }
        catch (error) {
            return failure(error);
        }
    };
    server.registerTool('find_owner', {
        description: 'Find the component, team and developers responsible for something, and whether their nodes are online. Accepts a component, endpoint ("POST /api/payments"), task key, file path ("repo:path/file.go"), team, or description.',
        inputSchema: { resource: z.string() },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, tool((a) => session.findOwner(a.resource)));
    server.registerTool('get_context', {
        description: 'Everything shared memory knows about a subject, with provenance: contract (fields, required/nullable, enums, errors, auth), implementation and test status, commit, freshness, confidence, open conflicts, human decisions and earlier answers. Subject: endpoint ("GET /api/resources/{id}" or concrete), component, task key or topic.',
        inputSchema: { subject: z.string() },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, tool((a) => session.getContext(a.subject)));
    server.registerTool('get_dependencies', {
        description: 'Before starting work: what a task or component depends on, owners, implementation status, contract availability, open conflicts and readiness. For a component, also lists its dependents.',
        inputSchema: { task: z.string().optional(), component: z.string().optional(), subject: z.string().optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, tool((a) => session.getDependencies(a)));
    server.registerTool('publish_context', {
        description: 'Share knowledge about work you own with every member allowed to see it (end-to-end encrypted). type "api_contract": data like {"method":"GET","path":"/api/x/{id}","auth":"bearer","request":{"fields":{...}},"response":{"fields":{"status":{"type":"string","enum":["A","B"]},"region":{"type":"string","nullable":true}}},"errors":["NOT_FOUND"]}. Field facts are compared across sources to detect conflicts; breaking changes notify consuming teams. Include commit, status, tests and verified_against.',
        inputSchema: {
            subject: z.string(),
            type: z.enum(['api_contract', 'implementation_status', 'known_limitation', 'behavior', 'schema', 'dependency', 'note']),
            summary: z.string().optional(),
            data: z.record(z.string(), z.unknown()).optional(),
            component: z.string().optional(),
            status: z.enum(['planned', 'in_progress', 'complete', 'deprecated']).optional(),
            tests: z.enum(['passing', 'failing', 'none', 'unknown']).optional(),
            commit: z.string().optional(),
            verified_against: z.array(z.enum(['code', 'tests', 'openapi', 'doc'])).optional(),
            facts: z.array(factSchema).optional(),
            depends_on: z.array(z.string()).optional(),
            supersedes: z.string().optional(),
        },
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    }, tool((a) => session.publishContext(a)));
    server.registerTool('ask', {
        description: 'Ask the owning team\'s agents a question, end-to-end encrypted. priority "urgent" (you are blocked now): delivered in real time to the whole owning team, may be answered automatically without developer approval; pass wait_seconds (≤120) to wait for the answer inline. "normal": queued for the owners\' agents. Check get_context first.',
        inputSchema: {
            question: z.string(),
            owner: z.string().optional().describe('Component (preferred), team or developer. Inferred from subject when omitted.'),
            subject: z.string().optional(),
            priority: z.enum(['urgent', 'normal']).optional(),
            details: z.record(z.string(), z.unknown()).optional(),
            wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.ask(a)));
    server.registerTool('announce_change', {
        description: 'Tell other teams about a change they may need to adopt: kind "change_notice" (behavior/contract change) or "implementation_doc" (a new feature and how to use it, with a markdown doc). Sent to consuming components by default (or "to": components, teams, developers). Low priority; queued for each recipient developer\'s approval. You receive their receipts.',
        inputSchema: {
            subject: z.string(),
            title: z.string(),
            summary: z.string(),
            doc: z.string().optional(),
            kind: z.enum(['change_notice', 'implementation_doc']).optional(),
            action_required: z.boolean().optional(),
            to: z.array(z.string()).optional(),
            component: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.announceChange(a)));
    server.registerTool('report_conflict', {
        description: 'Report that sources disagree (e.g. task says optional, contract/code say required). Routed to the owning team; the outcome arrives in get_inbox. Include every source with refs.',
        inputSchema: {
            subject: z.string(),
            sources: z.array(z.object({ source: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]), ref: z.string().optional() })).min(2),
            field: z.string().optional(),
            property: z.string().optional(),
            description: z.string().optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            owner: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.reportConflict(a)));
    server.registerTool('resolve_conflict', {
        description: 'Settle a conflict on a component you own when evidence determines the answer. The settlement is shared with every member who can see the component. For product/architecture decisions, escalate with respond instead.',
        inputSchema: {
            conflict_id: z.string(),
            resolution: z.string(),
            correct_value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
            outdated_sources: z.array(z.string()).optional(),
            follow_up: z.array(z.string()).optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.resolveConflict(a)));
    server.registerTool('get_inbox', {
        description: 'Your queue: urgent_enquiries and enquiries to answer, conflict_reports and local_conflicts on your components, answers and receipts for you (shown once), awaiting_your_developer (items needing approval or decision), approved_actions (approved work to implement), and waiting_on_others.',
        inputSchema: {},
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool(() => session.inbox()));
    server.registerTool('respond', {
        description: 'Answer an enquiry or conflict addressed to your component. action "answer": inspect code/tests first; give evidence (file:line) and confidence. Answers are also shared as memory. "decline": wrong recipient (reason). "escalate": a product/architecture decision is needed; give summary, evidence and options. It then waits for your developer. For local conflicts pass conflict_id instead of message_id.',
        inputSchema: {
            message_id: z.string().optional(),
            conflict_id: z.string().optional(),
            action: z.enum(['answer', 'decline', 'escalate']),
            answer: z.string().optional(),
            evidence: z.array(z.string()).optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            verified_against: z.array(z.string()).optional(),
            publish_as_context: z.boolean().optional(),
            summary: z.string().optional(),
            options: z.array(z.string()).optional(),
            reason: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.respond(a)));
    server.registerTool('decide', {
        description: 'Record YOUR DEVELOPER\'S explicit decision on an item in awaiting_your_developer or approved_actions: "approve" / "reject" / "defer" (change notices, implementation docs, memory updates), "done" (approved work finished), or "answer" with text/option (escalated questions and conflicts). Never decide on their behalf.',
        inputSchema: {
            item_id: z.string(),
            decision: z.enum(['approve', 'reject', 'defer', 'done', 'answer']),
            text: z.string().optional(),
            option: z.number().int().positive().optional(),
            note: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool((a) => session.decide(a)));
    return server;
}
export async function serveStdio(session) {
    const server = buildMcpServer(session);
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=mcp.js.map