#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
// node:sqlite still emits an ExperimentalWarning on Node 22/24. The API we use is stable in practice, and the
// warning confuses people running the CLI, so drop that one warning (modules are imported lazily below for this).
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
    if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite is an experimental feature'))
        return;
    return emitWarning(warning, ...rest);
});
const HELP = `agent-network: shared memory and end-to-end encrypted messaging between your team's coding agents

Admin (org root):
  login --hub URL --email you@example.com     Sign in to a hub (emails you a code); logout | whoami
  org init --hub URL --org ID --developer ID --manifest org.yaml [--name N]   (signed in, or BOOTSTRAP_TOKEN when self-hosting)
  org invite <developer> [--hours 72]          Print a single-use invite code (send it privately)
  org pending                                  Join requests with their key fingerprints
  org approve <developer> [--fingerprint FP]   Certify a member; sends them the manifest and a memory snapshot
  org revoke <developer>
  org manifest <org.yaml>                      Publish a new ownership manifest to all members

Set up your projects and agent (works before you join, no hub needed):
  setup                                        Guided: your project folder(s) and the AI tool + model for background work
  project add <folder> [--name N] [--description "what it is"] [--notes "build/test"] [--repository ID]
  project list | remove <name>
  workspace set <name> --projects a,b | use <name|none> | list
  agent add <name> --tool <claude-code|codex|antigravity|gemini|opencode|custom|api> --model M [--responder]
  agent list | test <name> [--scope-check] | enable-responder | disable-responder
  scope [project] [--tool claude-code|codex|cursor|generic] [--write]   Rules that keep agents inside your project

Every developer:
  doctor [--hub URL]                           Check this computer: Node version, hub, clock, whether you are approved, with the fix for each problem
  join <invite-code> [--name N]                Create your keys and request membership
  orient                                       The project map your agent receives
  run                                          Keep your node connected: realtime sync, indexing, auto-responder, dashboard
  mcp [--agent A] [--component C]              Stdio MCP server for your coding agent (configure it in your agent)
  tools                                        The tools an agent can use, with their arguments
  call <tool> [--json '{...}' | --json-file F] Run one tool from the shell (same tools and arguments as the MCP server); prints JSON
  inbox [--wait SECONDS]                       Your queue; with --wait, blocks until something needs you (or the time is up)
  status | sync | index
  trace export [--run ID] [--out FILE]         Observer nodes only: the recorded messages as JSON lines (experiments)
  queue                                       Items waiting for your approval
  decide <item-id> <approve|reject|defer|done|answer> [--text T] [--option N] [--note N]

Options:
  --home DIR    Node directory (default: $AGENT_NETWORK_HOME or ~/.agent-network)
`;
function homeDir(option) {
    return resolve(option ?? process.env.AGENT_NETWORK_HOME ?? join(homedir(), '.agent-network'));
}
const print = (value) => void process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            home: { type: 'string' },
            hub: { type: 'string' },
            org: { type: 'string' },
            developer: { type: 'string' },
            name: { type: 'string' },
            manifest: { type: 'string' },
            hours: { type: 'string' },
            fingerprint: { type: 'string' },
            agent: { type: 'string' },
            component: { type: 'string' },
            text: { type: 'string' },
            option: { type: 'string' },
            note: { type: 'string' },
            email: { type: 'string' },
            code: { type: 'string' },
            'bootstrap-token': { type: 'string' },
            description: { type: 'string' },
            notes: { type: 'string' },
            repository: { type: 'string' },
            projects: { type: 'string' },
            tool: { type: 'string' },
            model: { type: 'string' },
            command: { type: 'string' },
            provider: { type: 'string' },
            'base-url': { type: 'string' },
            'api-key-env': { type: 'string' },
            'project-path': { type: 'string' },
            run: { type: 'string' },
            out: { type: 'string' },
            instructions: { type: 'string' },
            profile: { type: 'string' },
            responder: { type: 'boolean' },
            'enable-responder': { type: 'boolean' },
            'scope-check': { type: 'boolean' },
            write: { type: 'boolean' },
            json: { type: 'string' },
            'json-file': { type: 'string' },
            wait: { type: 'string' },
            'as-json': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [command, sub, arg, arg2] = positionals;
    if (!command || values.help || command === 'help')
        return void process.stdout.write(HELP);
    const home = homeDir(values.home);
    // Runs before anything that needs a newer Node, so an old Node gets a clear message instead of a stack trace.
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if ((major < 22 || (major === 22 && minor < 18)) && command !== 'doctor') {
        throw new Error(`agent-network needs Node.js 22.18 or newer, but this is ${process.version}. Run "agent-network doctor" for the exact fix (it works on any Node).`);
    }
    if (command === 'doctor') {
        const { runDoctor, formatDoctor } = await import('./node/doctor.js');
        const report = await runDoctor({ home, hub: values.hub });
        print(values['as-json'] ? report : formatDoctor(report));
        process.exitCode = report.ok ? 0 : 1;
        return;
    }
    if (command === 'tools') {
        const { describeTools } = await import('./tools.js');
        return print(describeTools());
    }
    if (command === 'login' || command === 'logout' || command === 'whoami') {
        const { runAccountCommand } = await import('./node/account.js');
        return runAccountCommand(command, values, print);
    }
    const { LOCAL_COMMANDS, runLocalCommand } = await import('./node/local-cli.js');
    if (LOCAL_COMMANDS.has(command))
        return runLocalCommand(command, positionals, values, home, print);
    const admin = await import('./node/admin.js');
    const { LocalNode } = await import('./node/node.js');
    if (command === 'org' && sub === 'init') {
        const { loadManifest } = await import('./config.js');
        const token = values['bootstrap-token'] ?? process.env.BOOTSTRAP_TOKEN;
        if (!values.hub || !values.org || !values.developer || !values.manifest) {
            throw new Error('usage: org init --hub URL --org ID --developer ID --manifest org.yaml   (signed in with "login", or with BOOTSTRAP_TOKEN on a self-hosted hub)');
        }
        const { loadSession } = await import('./node/account.js');
        const account = token ? undefined : (loadSession(values.hub) ?? undefined);
        if (!token && !account)
            throw new Error(`Sign in first: agent-network login --hub ${values.hub} --email you@example.com
(Self-hosting? Set BOOTSTRAP_TOKEN instead.)`);
        if (LocalNode.exists(home))
            throw new Error(`A node already exists in ${home}. Use --home to choose another directory.`);
        const { node, fingerprint } = await admin.initOrg({ home, hub: values.hub, org: values.org, developer: values.developer, name: values.name, manifest: loadManifest(values.manifest), bootstrapToken: token, account });
        node.close();
        print(`Org "${values.org}" created. You are its root.\nRoot fingerprint: ${fingerprint}\nNode: ${home}\nNext: agent-network org invite <developer>`);
        return;
    }
    if (command === 'join') {
        if (!sub)
            throw new Error('usage: join <invite-code> [--name N]');
        if (LocalNode.exists(home))
            throw new Error(`A node already exists in ${home}. Use --home to choose another directory.`);
        const joined = await admin.joinOrg({ home, code: sub, name: values.name });
        print(`Join request sent as ${joined.developer}.\nYour fingerprint: ${joined.fingerprint}\nOrg root fingerprint (pinned): ${joined.root_fingerprint}\n` +
            'Tell your admin your fingerprint so they can verify it. Meanwhile run "agent-network setup" to choose your project folder and AI model, then "agent-network run".');
        return;
    }
    const node = await LocalNode.open({ home });
    try {
        if (command === 'org') {
            switch (sub) {
                case 'invite': {
                    if (!arg)
                        throw new Error('usage: org invite <developer> [--hours 72]');
                    const invite = await admin.createInvite(node, arg, Number(values.hours ?? 72));
                    print(`Invite for ${arg} (expires ${invite.expires_at}). Send it privately; it is single-use:\n\n${invite.code}\n\nThey run: agent-network join <code>`);
                    return;
                }
                case 'pending':
                    return print(await admin.pendingJoins(node));
                case 'approve':
                    if (!arg)
                        throw new Error('usage: org approve <developer> [--fingerprint FP]');
                    return print(await admin.approveMember(node, arg, values.fingerprint));
                case 'revoke':
                    if (!arg)
                        throw new Error('usage: org revoke <developer>');
                    return print(await admin.revokeMember(node, arg));
                case 'manifest': {
                    if (!arg)
                        throw new Error('usage: org manifest <org.yaml>');
                    const { loadManifest } = await import('./config.js');
                    return print(await admin.publishManifest(node, loadManifest(arg)));
                }
            }
            throw new Error(`unknown org command "${sub ?? ''}"`);
        }
        const { AgentSession } = await import('./node/session.js');
        // Infer the component from the working directory when the agent runs inside a configured repository.
        const cwd = process.cwd();
        const repository = Object.entries(node.ctx.config.repositories).find(([, r]) => r.path && (cwd + sep).startsWith(resolve(node.settings.baseDir, r.path) + sep))?.[0] ?? null;
        const session = new AgentSession(node, { agent: values.agent ?? process.env.AGENT_NETWORK_AGENT ?? 'agent', component: values.component ?? null, repository, cwd });
        switch (command) {
            case 'mcp': {
                const { serveStdio } = await import('./mcp.js');
                // Experiments: "minimal" names the tools without saying when to use them (see docs/EXPERIMENT.md, prompt variant P0).
                if (values.instructions)
                    process.env.AGENT_NETWORK_INSTRUCTIONS = values.instructions;
                node.ctx.log = (message) => process.stderr.write(`[agent-network] ${message}\n`);
                await serveStdio(session);
                return new Promise(() => undefined); // keep the node open while the agent is connected
            }
            case 'run': {
                const { runDaemon } = await import('./node/daemon.js');
                const daemon = await runDaemon(node);
                print(`Node running for ${node.developer} (${node.keys.org}). Dashboard: ${daemon.dashboardUrl ?? 'disabled'}`);
                const stop = async () => {
                    await daemon.stop();
                    node.close();
                    process.exit(0);
                };
                process.on('SIGINT', () => void stop());
                process.on('SIGTERM', () => void stop());
                return new Promise(() => undefined);
            }
            case 'status': {
                const manifest = node.manifest();
                return print({
                    developer: node.developer,
                    org: node.keys.org,
                    hub: node.settings.hub,
                    root: node.keys.root,
                    manifest_version: manifest?.version ?? null,
                    observers: node.observers(),
                    observer_mode: node.settings.observer,
                    members: node.ctx.db.all("SELECT id, status, fingerprint FROM members ORDER BY id"),
                    last_sync: node.state('last_pull'),
                    realtime: node.daemonAlive(),
                    pending_outbound: node.ctx.db.get("SELECT count(*) AS n FROM outbox WHERE state = 'pending'").n,
                });
            }
            case 'orient':
                return print(session.orient());
            case 'call': {
                // The shell route to the same tools the MCP server offers (docs/ACCESS.md, mode B). Output is always one JSON object.
                const { TOOLS, toolByName, parseToolArgs } = await import('./tools.js');
                const def = toolByName(sub ?? '');
                if (!def)
                    throw new Error(`usage: call <tool> [--json '{"key":"value"}' | --json-file FILE]\nTools: ${TOOLS.map((tool) => tool.name).join(', ')}   (details: agent-network tools)`);
                let args = {};
                try {
                    const { readFileSync } = await import('node:fs');
                    const text = values['json-file'] ? readFileSync(resolve(values['json-file']), 'utf8') : values.json;
                    if (text)
                        args = JSON.parse(text);
                }
                catch (error) {
                    throw new Error(`The arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}). Put the JSON in single quotes, or write it to a file and use --json-file.`);
                }
                try {
                    const result = await def.run(session, parseToolArgs(def, args));
                    return print({ ok: true, result, notice: session.notice() });
                }
                catch (error) {
                    const { NetworkError } = await import('./errors.js');
                    process.exitCode = 1;
                    return print({ ok: false, error: error instanceof NetworkError ? `${error.code}: ${error.message}` : `ERROR: ${error instanceof Error ? error.message : String(error)}` });
                }
            }
            case 'inbox': {
                // Without --wait this is the get_inbox tool. With it, the command blocks until an enquiry or an answer needs you.
                const waitSeconds = Math.min(Math.max(Number(values.wait ?? 0) || 0, 0), 600);
                const started = Date.now();
                await session.sync(true);
                while (session.actionable() === 0 && Date.now() - started < waitSeconds * 1000) {
                    await new Promise((done) => setTimeout(done, 2000));
                    await session.sync(true);
                }
                const nothingNew = session.actionable() === 0;
                const result = await session.inbox();
                return print({ ok: true, waited_seconds: Math.round((Date.now() - started) / 1000), nothing_new: nothingNew, result, notice: session.notice() });
            }
            case 'trace': {
                if (sub !== 'export')
                    throw new Error('usage: trace export [--run ID] [--out FILE]');
                if (!node.settings.observer)
                    throw new Error('This node is not an observer. Set "observer: true" in node.yaml (only for an admin the manifest lists under "observers").');
                const { exportTrace, traceToJsonl } = await import('./node/trace.js');
                const lines = traceToJsonl(exportTrace(node.ctx, { run: values.run ?? null }));
                if (values.out) {
                    const { writeFileSync } = await import('node:fs');
                    writeFileSync(resolve(values.out), lines);
                    return print(`Wrote ${lines ? lines.trimEnd().split('\n').length : 0} events to ${resolve(values.out)}`);
                }
                return void process.stdout.write(lines);
            }
            case 'sync':
                await session.sync(true);
                return print({ synced: !session.offline, error: session.offline, last_sync: node.state('last_pull') });
            case 'index': {
                const report = await node.index();
                for (const repo of report.repositories)
                    for (const c of repo.contract_changes)
                        await session.notifyConsumers(c.subject, c.key, c.component, c.changes);
                await node.publishPending();
                return print(report);
            }
            case 'queue':
                return print((await session.inbox()).awaiting_your_developer);
            case 'decide':
                if (!sub || !arg)
                    throw new Error('usage: decide <item-id> <approve|reject|defer|done|answer> [--text T] [--option N] [--note N]');
                return print(await session.decide({ item_id: sub, decision: arg, text: values.text, option: values.option ? Number(values.option) : undefined, note: values.note ?? arg2 }, 'cli'));
        }
        throw new Error(`unknown command "${command}"\n\n${HELP}`);
    }
    finally {
        if (command !== 'mcp' && command !== 'run')
            node.close();
    }
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map