/**
 * Stdio MCP server: each agent (Claude Code, Codex, Cursor, ...) launches this locally. Reads are served from the
 * developer's local graph memory; messages go through the node, end-to-end encrypted.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NetworkError } from './errors.js';
import { TOOLS } from './tools.js';
export const SERVER_VERSION = '0.2.0';
export const SERVER_INSTRUCTIONS = `Agent Network: shared engineering memory and end-to-end encrypted messaging between your team's coding agents.
Reads (get_context, find_owner, get_dependencies) come from local graph memory: instant, and they work offline.

- At session start call orient: it tells you which folders are yours, what each project is, and which components live there. Stay inside those folders; do not scan the machine.
- At session start and between tasks, call get_inbox. Answer URGENT enquiries first. Answering factual questions about code you own needs no developer approval.
- Before building against another component, call get_context or get_dependencies. Only ask when memory is missing, stale or low-confidence.
- ask with priority "urgent" only when you are blocked right now: it reaches the whole owning team and may be answered automatically (use wait_seconds). Otherwise use "normal".
- After finishing work others consume, call publish_context (contract, status, tests, commit). Breaking contract changes notify consuming teams automatically.
- For new features or behavior changes other teams must adopt, call announce_change. It is queued for their developers' approval.
- Items in get_inbox → awaiting_your_developer (change notices, implementation docs, memory updates, escalations) need your developer: summarize them and ask. Call decide only with the developer's explicit decision.
- Never make product or architecture decisions for another team; escalate with respond(action="escalate").`;
/**
 * Experiment variant "P0": names the tools and says nothing about when to use them. Selected with
 * AGENT_NETWORK_INSTRUCTIONS=minimal. (Tool descriptions still steer behavior; that is part of the tool and is recorded.)
 */
export const MINIMAL_INSTRUCTIONS = `Agent Network: encrypted messaging and shared memory between the coding agents of one org. Tools: orient, find_owner, get_context, get_dependencies, publish_context, ask, announce_change, report_conflict, resolve_conflict, get_inbox, respond, decide.`;
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
/** The static guidance plus this node's project boundary, so the agent knows its scope without a single tool call. */
export function instructionsFor(session) {
    const map = session.orient();
    const lines = [process.env.AGENT_NETWORK_INSTRUCTIONS === 'minimal' ? MINIMAL_INSTRUCTIONS : SERVER_INSTRUCTIONS, '', 'Your scope:'];
    if (map.projects.length === 0)
        lines.push(...map.rules.map((rule) => `- ${rule}`));
    else {
        for (const project of map.projects) {
            lines.push(`- ${project.name}${project.description ? `: ${project.description}` : ''} (${project.paths.join(', ')})${project.name === map.you_are_in ? ' ← you are here' : ''}`);
            if (project.notes)
                lines.push(`  ${project.notes.replace(/\s+/g, ' ').trim()}`);
        }
        lines.push(...map.rules.map((rule) => `- ${rule}`));
    }
    if (map.observed_by.length)
        lines.push('', `This org is observed for evaluation: every message you send or receive is also readable by ${map.observed_by.join(', ')}. Do not put real credentials in messages.`);
    return lines.join('\n');
}
export function buildMcpServer(session) {
    const server = new McpServer({ name: 'agent-network', version: SERVER_VERSION }, { instructions: instructionsFor(session) });
    // The tools come from the shared registry (src/tools.ts): the command line runs the same handlers ("agent-network call").
    for (const def of TOOLS) {
        server.registerTool(def.name, {
            description: def.description,
            inputSchema: def.shape,
            annotations: { readOnlyHint: def.readOnly, ...(def.idempotent ? { idempotentHint: true } : {}), openWorldHint: !def.readOnly },
        }, async (args) => {
            try {
                return result(session, await def.run(session, args));
            }
            catch (error) {
                return failure(error);
            }
        });
    }
    return server;
}
export async function serveStdio(session) {
    const server = buildMcpServer(session);
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=mcp.js.map