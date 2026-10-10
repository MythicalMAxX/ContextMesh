/**
 * The tool registry: one list that every way into a node reads. The stdio MCP server (src/mcp.ts) registers these as MCP tools;
 * the command line (`agent-network call <tool> --json '{...}'`) runs the very same handlers with the very same schemas. So an agent
 * that can only run shell commands behaves exactly like one that has the MCP server (docs/ACCESS.md, modes A and B).
 */
import { z } from 'zod';
import { FACT_LOCATIONS, FACT_PROPERTIES, SOURCE_KINDS } from './types.js';
const factSchema = z.object({
    subject: z.string().optional(),
    field: z.string(),
    property: z.enum(FACT_PROPERTIES),
    value: z.union([z.boolean(), z.string(), z.array(z.string())]),
    location: z.enum(FACT_LOCATIONS).optional(),
    source: z.enum(SOURCE_KINDS).optional(),
    evidence: z.string().optional(),
});
export const TOOLS = [
    {
        name: 'orient',
        description: 'Call first. The project map for this machine: the folders you may work in, what each project is, how to build and test it, the shared components that live there and who owns them, plus the rules for staying in scope. Use it instead of exploring the file system.',
        shape: {},
        readOnly: true,
        run: async (s) => s.orient(),
    },
    {
        name: 'find_owner',
        description: 'Find the component, team and developers responsible for something, and whether their nodes are online. Accepts a component, endpoint ("POST /api/payments"), task key, file path ("repo:path/file.go"), team, or description.',
        shape: { resource: z.string() },
        readOnly: true,
        run: (s, a) => s.findOwner(a.resource),
    },
    {
        name: 'get_context',
        description: 'Everything shared memory knows about a subject, with provenance: contract (fields, required/nullable, enums, errors, auth), implementation and test status, commit, freshness, confidence, open conflicts, human decisions and earlier answers. Subject: endpoint ("GET /api/resources/{id}" or concrete), component, task key or topic.',
        shape: { subject: z.string() },
        readOnly: true,
        run: (s, a) => s.getContext(a.subject),
    },
    {
        name: 'get_dependencies',
        description: 'Before starting work: what a task or component depends on, owners, implementation status, contract availability, open conflicts and readiness. For a component, also lists its dependents.',
        shape: { task: z.string().optional(), component: z.string().optional(), subject: z.string().optional() },
        readOnly: true,
        run: (s, a) => s.getDependencies(a),
    },
    {
        name: 'publish_context',
        description: 'Share knowledge about work you own with every member allowed to see it (end-to-end encrypted). type "api_contract": data like {"method":"GET","path":"/api/x/{id}","auth":"bearer","request":{"fields":{...}},"response":{"fields":{"status":{"type":"string","enum":["A","B"]},"region":{"type":"string","nullable":true}}},"errors":["NOT_FOUND"]}. Field facts are compared across sources to detect conflicts; breaking changes notify consuming teams. Include commit, status, tests and verified_against.',
        shape: {
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
        readOnly: false,
        idempotent: true,
        run: (s, a) => s.publishContext(a),
    },
    {
        name: 'ask',
        description: 'Ask the owning team\'s agents a question, end-to-end encrypted. priority "urgent" (you are blocked now): delivered in real time to the whole owning team, may be answered automatically without developer approval; "normal": queued for the owners\' agents. Either way the call waits for the answer (30 seconds unless you pass wait_seconds, up to 120; 0 = do not wait). Do not carry on with a guess while the answer is pending. Check get_context first.',
        shape: {
            question: z.string(),
            owner: z.string().optional().describe('Component (preferred), team or developer. Inferred from subject when omitted.'),
            to: z.string().optional().describe('Same as owner (accepted because agents often write "to").'),
            subject: z.string().optional(),
            priority: z.enum(['urgent', 'normal']).optional(),
            details: z.record(z.string(), z.unknown()).optional(),
            wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        readOnly: false,
        run: (s, { to, ...a }) => s.ask({ ...a, owner: a.owner ?? to }),
    },
    {
        name: 'announce_change',
        description: 'Tell other teams about a change they may need to adopt: kind "change_notice" (behavior/contract change) or "implementation_doc" (a new feature and how to use it, with a markdown doc). Sent to consuming components by default (or "to": components, teams, developers). Low priority; queued for each recipient developer\'s approval. You receive their receipts.',
        shape: {
            subject: z.string(),
            title: z.string(),
            summary: z.string(),
            doc: z.string().optional(),
            kind: z.enum(['change_notice', 'implementation_doc']).optional(),
            action_required: z.boolean().optional(),
            to: z.array(z.string()).optional(),
            component: z.string().optional(),
        },
        readOnly: false,
        run: (s, a) => s.announceChange(a),
    },
    {
        name: 'report_conflict',
        description: 'Report that sources disagree (e.g. task says optional, contract/code say required). Routed to the owning team; the outcome arrives in get_inbox. Include every source with refs.',
        shape: {
            subject: z.string(),
            sources: z.array(z.object({ source: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]), ref: z.string().optional() })).min(2),
            field: z.string().optional(),
            property: z.string().optional(),
            description: z.string().optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            owner: z.string().optional(),
        },
        readOnly: false,
        run: (s, a) => s.reportConflict(a),
    },
    {
        name: 'resolve_conflict',
        description: 'Settle a conflict on a component you own when evidence determines the answer. The settlement is shared with every member who can see the component. For product/architecture decisions, escalate with respond instead.',
        shape: {
            conflict_id: z.string(),
            resolution: z.string(),
            correct_value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
            outdated_sources: z.array(z.string()).optional(),
            follow_up: z.array(z.string()).optional(),
        },
        readOnly: false,
        run: (s, a) => s.resolveConflict(a),
    },
    {
        name: 'get_inbox',
        description: 'Your queue: urgent_enquiries and enquiries to answer, conflict_reports and local_conflicts on your components, answers and receipts for you (shown once), awaiting_your_developer (items needing approval or decision), approved_actions (approved work to implement), and waiting_on_others.',
        shape: {},
        readOnly: false,
        run: (s) => s.inbox(),
    },
    {
        name: 'respond',
        description: 'Answer an enquiry or conflict addressed to your component. action "answer": inspect code/tests first; give evidence (file:line) and confidence. Answers are also shared as memory. "decline": wrong recipient (reason). "escalate": a product/architecture decision is needed; give summary, evidence and options. It then waits for your developer. For local conflicts pass conflict_id instead of message_id. If the enquiry lists a relationship scope, answer only from files matching it; if it says answers need approval, your answer is held for your developer.',
        shape: {
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
        readOnly: false,
        run: (s, a) => s.respond(a),
    },
    {
        name: 'decide',
        description: 'Record YOUR DEVELOPER\'S explicit decision on an item in awaiting_your_developer or approved_actions: "approve" / "reject" / "defer" (change notices, implementation docs, memory updates, held answers), "done" (approved work finished), or "answer" with text/option (escalated questions and conflicts). Never decide on their behalf.',
        shape: {
            item_id: z.string(),
            decision: z.enum(['approve', 'reject', 'defer', 'done', 'answer']),
            text: z.string().optional(),
            option: z.number().int().positive().optional(),
            note: z.string().optional(),
        },
        readOnly: false,
        run: (s, a) => s.decide(a),
    },
];
export const toolByName = (name) => TOOLS.find((tool) => tool.name === name);
/** Validates arguments the way the MCP SDK does, and says which argument is wrong. */
export function parseToolArgs(tool, raw) {
    const parsed = z.object(tool.shape).safeParse(raw ?? {});
    if (parsed.success)
        return parsed.data;
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`);
    throw new Error(`Invalid arguments for ${tool.name}: ${issues.join('; ')}`);
}
/** One line per tool for `agent-network tools`: the name, the arguments and what it is for. */
export function describeTools() {
    return TOOLS.map((tool) => ({
        tool: tool.name,
        arguments: Object.fromEntries(Object.entries(tool.shape).map(([key, schema]) => [key, `${schema.safeParse(undefined).success ? 'optional' : 'required'}`])),
        description: tool.description,
    }));
}
//# sourceMappingURL=tools.js.map