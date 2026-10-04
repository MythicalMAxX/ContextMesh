/**
 * Commands that only need node.yaml (no keys, no hub): project and workspace scope, the agent that runs background
 * work, guided setup, and agent rule files. They work before the node has joined an org.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadNodeConfig } from '../config.js';
import { invalid } from '../errors.js';
import { activeProjects } from '../scope.js';
import { runProfile, scopeCheck, TOOLS } from './runtime.js';
import { addProfile, addProject, enableResponder, removeProject, RULE_FILES, runSetup, scopeBlockFor, setWorkspace, useWorkspace, withScopeBlock } from './setup.js';
export const LOCAL_COMMANDS = new Set(['project', 'workspace', 'agent', 'setup', 'scope']);
const str = (value) => (typeof value === 'string' ? value : undefined);
function summarize(settings) {
    return {
        workspace: settings.workspace ?? null,
        projects: Object.fromEntries(activeProjects({ ...settings, workspace: undefined }).map((p) => [p.name, { description: p.description || null, paths: p.paths, repository: p.repository, notes: p.notes }])),
        workspaces: settings.workspaces,
        agent_profiles: settings.agents.profiles,
        responder: { enabled: settings.responder.enabled, profile: settings.responder.profile ?? null },
    };
}
export async function runLocalCommand(command, positionals, values, home, print) {
    const [, sub, arg] = positionals;
    const configFile = join(home, 'node.yaml');
    if (!existsSync(configFile))
        throw new Error(`No node found in ${home}. Run "agent-network join <invite>" or "agent-network org init" first.`);
    switch (command) {
        case 'project': {
            if (sub === 'add') {
                if (!arg)
                    throw new Error('usage: project add <folder> [--name N] [--description "what it is"] [--notes "how to build/test"] [--repository ID]');
                return print(addProject(home, { path: arg, name: str(values.name), description: str(values.description), notes: str(values.notes), repository: str(values.repository) }));
            }
            if (sub === 'remove') {
                if (!arg)
                    throw new Error('usage: project remove <name>');
                removeProject(home, arg);
                return print(`Removed project "${arg}".`);
            }
            if (sub === 'list' || !sub)
                return print(summarize(loadNodeConfig(configFile)).projects);
            throw new Error(`unknown project command "${sub}"`);
        }
        case 'workspace': {
            if (sub === 'set') {
                const projects = str(values.projects)?.split(',').map((p) => p.trim()).filter(Boolean);
                if (!arg || !projects?.length)
                    throw new Error('usage: workspace set <name> --projects a,b [--description D]');
                setWorkspace(home, arg, projects, str(values.description));
                return print(`Workspace "${arg}" covers ${projects.join(', ')}. Select it with: agent-network workspace use ${arg}`);
            }
            if (sub === 'use') {
                if (!arg)
                    throw new Error('usage: workspace use <name|none>');
                useWorkspace(home, arg === 'none' ? null : arg);
                return print(arg === 'none' ? 'All projects are in scope.' : `Agents are now oriented to workspace "${arg}".`);
            }
            if (sub === 'list' || !sub) {
                const settings = loadNodeConfig(configFile);
                return print({ active: settings.workspace ?? null, workspaces: settings.workspaces });
            }
            throw new Error(`unknown workspace command "${sub}"`);
        }
        case 'agent': {
            const settings = loadNodeConfig(configFile);
            if (sub === 'list' || !sub)
                return print({ profiles: settings.agents.profiles, responder: summarize(settings).responder });
            if (sub === 'add') {
                if (!arg)
                    throw new Error('usage: agent add <name> --tool <claude-code|codex|antigravity|gemini|opencode|custom|api> --model M [--command "cmd {model}"] [--provider P --base-url U --api-key-env VAR] [--responder]');
                const input = {
                    tool: str(values.tool),
                    model: str(values.model),
                    command: str(values.command)?.split(/\s+/).filter(Boolean),
                    provider: str(values.provider),
                    base_url: str(values['base-url']),
                    api_key_env: str(values['api-key-env']),
                };
                const profile = addProfile(home, arg, input, values.responder ? 'responder' : undefined);
                const note = TOOLS[profile.tool].confinement === 'best-effort' ? ' Read-only, project-only mode for this tool has not been tested here; check it with: agent-network agent test ' + arg + ' --scope-check' : '';
                return print(`Saved profile "${arg}": ${profile.tool}${profile.model ? ` with ${profile.model}` : ''}.${values.responder ? ' The responder uses it.' : ''}${note}`);
            }
            if (sub === 'enable-responder' || sub === 'disable-responder') {
                enableResponder(home, sub === 'enable-responder');
                return print(sub === 'enable-responder' ? 'The responder is on.' : 'The responder is off.');
            }
            if (sub === 'test') {
                const name = arg ?? settings.responder.profile;
                const profile = name ? settings.agents.profiles[name] : undefined;
                if (!name || !profile)
                    throw invalid(`Unknown profile "${name ?? ''}". See: agent-network agent list`);
                if (values['scope-check'])
                    return print(await scopeCheck(profile));
                const cwd = activeProjects({ ...settings, workspace: undefined })[0]?.paths[0] ?? home;
                const result = await runProfile(profile, 'Reply with the single word OK.', { cwd });
                return print({ profile: name, tool: profile.tool, model: profile.model ?? null, ok: result.ok, seconds: result.seconds, reply: result.text.slice(0, 200), ...(result.error ? { error: result.error } : {}) });
            }
            throw new Error(`unknown agent command "${sub}"`);
        }
        case 'setup': {
            const scripted = values['project-path'] !== undefined || values.tool !== undefined;
            if (scripted) {
                const out = [];
                if (values['project-path'] !== undefined) {
                    const added = addProject(home, { path: str(values['project-path']), name: str(values.name), description: str(values.description), notes: str(values.notes) });
                    out.push(`Project "${added.name}": ${added.paths.join(', ')}`);
                }
                if (values.tool !== undefined) {
                    const profile = addProfile(home, str(values.profile) ?? 'background', { tool: str(values.tool), model: str(values.model), command: str(values.command)?.split(/\s+/).filter(Boolean) }, 'responder');
                    out.push(`Agent profile: ${profile.tool}${profile.model ? ` with ${profile.model}` : ''}`);
                }
                if (values['enable-responder']) {
                    enableResponder(home, true);
                    out.push('Responder: on');
                }
                return print(out.join('\n'));
            }
            if (!process.stdin.isTTY)
                throw new Error('Interactive setup needs a terminal. Script it instead: setup --project-path DIR [--name N --description D] [--tool T --model M]');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                await runSetup(home, {
                    say: (text) => void process.stdout.write(`${text}\n`),
                    ask: async (question, fallback) => (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback || '',
                });
            }
            finally {
                rl.close();
            }
            return;
        }
        case 'scope': {
            // `scope` prints the rule block for your project(s); with --write it puts it in the tool's rules file.
            const settings = loadNodeConfig(configFile);
            const target = (str(values.tool) ?? 'generic');
            if (!(target in RULE_FILES))
                throw invalid(`Unknown target "${target}". Choose one of: ${Object.keys(RULE_FILES).join(', ')}.`);
            const { block, projects } = scopeBlockFor(settings, sub);
            if (projects.length === 0)
                throw invalid('No project set up yet. Run: agent-network setup');
            if (!values.write)
                return print(`${block}\n\n(Preview. Add --write to put this in ${RULE_FILES[target]} inside each project folder.)`);
            const written = [];
            for (const project of projects) {
                const file = join(project.paths[0], RULE_FILES[target]);
                mkdirSync(dirname(file), { recursive: true });
                const { block: own } = scopeBlockFor(settings, project.name);
                const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
                // Cursor only applies a rule file that carries this header.
                const header = target === 'cursor' && !existing.startsWith('---') ? '---\ndescription: Agent Network project scope\nalwaysApply: true\n---\n\n' : '';
                writeFileSync(file, header + withScopeBlock(existing, own));
                written.push(file);
            }
            return print(`Updated:\n${written.join('\n')}`);
        }
    }
    throw new Error(`unknown command "${command}"`);
}
//# sourceMappingURL=local-cli.js.map