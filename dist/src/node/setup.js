/**
 * Guided and scripted setup of a node: which folders are the project, and which tool and model run background work.
 * Every change is validated against the full node configuration before it is written, and node.yaml keeps its comments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import { parseNodeConfig, RUNTIME_TOOLS } from '../config.js';
import { invalid } from '../errors.js';
import { activeProjects, scopeRuleBlock, SCOPE_MARKERS, validateProjectPath } from '../scope.js';
import { detectTools, TOOLS } from './runtime.js';
/** Applies `mutate` to node.yaml, validates the result as a whole, and only then writes it. */
export function editNodeConfig(home, mutate) {
    const file = join(home, 'node.yaml');
    const doc = parseDocument(readFileSync(file, 'utf8'));
    mutate(doc);
    const next = parseNodeConfig(doc.toJS(), home);
    writeFileSync(file, String(doc));
    return next;
}
const slug = (text) => {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    return cleaned || 'project';
};
/** Adds a project, or adds another folder to an existing one of the same name. */
export function addProject(home, input) {
    const path = validateProjectPath(input.path);
    const name = input.name ?? slug(basename(path));
    const config = editNodeConfig(home, (doc) => {
        const existing = doc.getIn(['projects', name]);
        if (existing?.toJSON) {
            const paths = existing.toJSON().paths;
            if (!paths.includes(path))
                doc.setIn(['projects', name, 'paths'], [...paths, path]);
            if (input.description !== undefined)
                doc.setIn(['projects', name, 'description'], input.description);
            if (input.notes !== undefined)
                doc.setIn(['projects', name, 'notes'], input.notes);
            if (input.repository !== undefined)
                doc.setIn(['projects', name, 'repository'], input.repository);
            return;
        }
        doc.setIn(['projects', name], {
            description: input.description ?? '',
            paths: [path],
            ...(input.repository ? { repository: input.repository } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
        });
    });
    return { name, paths: config.projects[name].paths };
}
export function removeProject(home, name) {
    editNodeConfig(home, (doc) => {
        if (!doc.hasIn(['projects', name]))
            throw invalid(`No project named "${name}".`);
        doc.deleteIn(['projects', name]);
        const workspaces = doc.getIn(['workspaces'])?.toJSON?.() ?? {};
        for (const [workspace, value] of Object.entries(workspaces)) {
            const rest = value.projects.filter((p) => p !== name);
            if (rest.length === 0) {
                doc.deleteIn(['workspaces', workspace]);
                if (doc.get('workspace') === workspace)
                    doc.delete('workspace');
            }
            else if (rest.length !== value.projects.length)
                doc.setIn(['workspaces', workspace, 'projects'], rest);
        }
    });
}
export function setWorkspace(home, name, projects, description = '') {
    editNodeConfig(home, (doc) => doc.setIn(['workspaces', name], { description, projects }));
}
export function useWorkspace(home, name) {
    editNodeConfig(home, (doc) => (name ? doc.set('workspace', name) : doc.delete('workspace')));
}
/** Saves a named way of running an agent; when `job` is given, that job (the responder) uses it from now on. */
export function addProfile(home, name, input, job) {
    if (!RUNTIME_TOOLS.includes(input.tool))
        throw invalid(`Unknown tool "${input.tool}". Choose one of: ${RUNTIME_TOOLS.join(', ')}.`);
    const config = editNodeConfig(home, (doc) => {
        const profile = { tool: input.tool };
        for (const key of ['model', 'command', 'provider', 'base_url', 'api_key_env'])
            if (input[key] !== undefined)
                profile[key] = input[key];
        if (input.args?.length)
            profile.args = input.args;
        doc.setIn(['agents', 'profiles', name], profile);
        if (job === 'responder')
            doc.setIn(['responder', 'profile'], name);
    });
    return config.agents.profiles[name];
}
export function enableResponder(home, enabled) {
    editNodeConfig(home, (doc) => doc.setIn(['responder', 'enabled'], enabled));
}
/** The file each tool reads project rules from, relative to the project folder. */
export const RULE_FILES = {
    'claude-code': 'CLAUDE.md',
    codex: 'AGENTS.md',
    cursor: '.cursor/rules/agent-network.mdc',
    generic: 'AGENTS.md',
};
/** Inserts or refreshes the scope block in an existing rules file, leaving everything else as it was. */
export function withScopeBlock(existing, block) {
    const [start, end] = SCOPE_MARKERS;
    const from = existing.indexOf(start);
    const to = existing.indexOf(end);
    if (from !== -1 && to > from)
        return `${existing.slice(0, from)}${block}${existing.slice(to + end.length)}`;
    return `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n\n' : ''}${block}\n`;
}
export function scopeBlockFor(settings, project) {
    const projects = activeProjects(settings).filter((p) => !project || p.name === project);
    if (project && projects.length === 0)
        throw invalid(`No project named "${project}" in the active workspace.`);
    return { block: scopeRuleBlock(projects), projects };
}
const yes = (answer) => /^y(es)?$/i.test(answer.trim());
/**
 * Plain-language setup: which folder is your project, what is it, and which AI tool and model should the node use for
 * background work. Re-run it any time; it adds to what is there.
 */
export async function runSetup(home, io, startDir = process.cwd()) {
    io.say('Agent Network setup\n');
    io.say('1. Your project\nAgents will only be pointed at the folders you list here, so they never go searching your whole computer.\n');
    let first = true;
    let suggestion = startDir;
    for (;;) {
        const path = await io.ask(first ? 'Folder of your project (leave empty to skip)' : 'Another folder (leave empty to continue)', suggestion);
        if (!path)
            break;
        let added;
        try {
            const name = await io.ask('Short name', slug(basename(path.replace(/[\\/]+$/, ''))));
            const description = await io.ask('What is this project, in one sentence?', '');
            added = addProject(home, { path, name, description: description || undefined });
            io.say(`  Added "${added.name}" (${added.paths.join(', ')}).\n`);
        }
        catch (error) {
            io.say(`  ${error instanceof Error ? error.message : String(error)}\n`);
            suggestion = '';
            continue;
        }
        first = false;
        suggestion = '';
        if (!yes(await io.ask('Add another folder or project? (y/N)', 'n')))
            break;
    }
    io.say('\n2. Which AI tool should Agent Network use for its own background work?\nThis is only for work the node starts itself (for example answering an urgent question while you are away). Your own agent is not affected.\n');
    const installed = detectTools();
    const tools = RUNTIME_TOOLS.filter((tool) => tool !== 'api');
    tools.forEach((tool, i) => io.say(`  ${i + 1}. ${TOOLS[tool].label}${installed[tool] ? '  (installed)' : ''}`));
    io.say(`  ${tools.length + 1}. ${TOOLS.api.label}`);
    const pick = await io.ask('Choose a number, or press Enter to skip', '');
    const index = Number(pick) - 1;
    if (!pick || !Number.isInteger(index) || index < 0 || index > tools.length) {
        io.say('\nSkipped. Background work stays off until you choose a tool: agent-network agent add');
        return;
    }
    const tool = index === tools.length ? 'api' : tools[index];
    const info = TOOLS[tool];
    const input = { tool };
    if (tool === 'custom') {
        io.say(`\n${info.hint}`);
        input.command = (await io.ask('Command (words separated by spaces)')).split(/\s+/).filter(Boolean);
    }
    else if (tool === 'api') {
        io.say(`\n${info.hint}`);
        input.provider = (await io.ask('Provider: openai-compatible or anthropic', 'openai-compatible'));
        if (input.provider === 'openai-compatible')
            input.base_url = await io.ask('Endpoint base URL (for example http://localhost:11434/v1)');
        input.api_key_env = (await io.ask('Name of the environment variable that holds the API key (empty if none)', '')) || undefined;
        input.model = await io.ask('Model name');
    }
    if (tool !== 'custom' && tool !== 'api') {
        io.say('\n3. Which model?');
        info.models.forEach((model, i) => io.say(`  ${i + 1}. ${model.id}  ${model.note}`));
        if (info.hint)
            io.say(`  ${info.hint}`);
        const choice = await io.ask(info.models.length ? 'Choose a number or type a model name' : 'Model name', info.models[0]?.id ?? '');
        const byNumber = info.models[Number(choice) - 1];
        input.model = byNumber?.id ?? choice;
    }
    if (!input.model && tool !== 'custom') {
        io.say('A model is needed, so nothing was saved. Run setup again.');
        return;
    }
    const profile = addProfile(home, 'background', input, 'responder');
    io.say(`\nSaved profile "background": ${profile.tool}${profile.model ? ` with ${profile.model}` : ''}.`);
    if (info.confinement === 'best-effort')
        io.say('Note: read-only, project-only mode for this tool follows its documented flags but has not been tested here. Check it with: agent-network agent test background --scope-check');
    if (yes(await io.ask('\nLet your node answer URGENT questions about your projects while you are away? (y/N)', 'n'))) {
        enableResponder(home, true);
        io.say('Turned on. It uses the profile above, only reads your project folders, and every answer is marked as automatic.');
    }
    io.say('\nDone. Next: agent-network run (keeps you connected) and connect your agent with: agent-network mcp');
}
//# sourceMappingURL=setup.js.map