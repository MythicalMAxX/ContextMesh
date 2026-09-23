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
  org init --hub URL --org ID --developer ID --manifest org.yaml [--name N]   (needs BOOTSTRAP_TOKEN)
  org invite <developer> [--hours 72]          Print a single-use invite code (send it privately)
  org pending                                  Join requests with their key fingerprints
  org approve <developer> [--fingerprint FP]   Certify a member; sends them the manifest and a memory snapshot
  org revoke <developer>
  org manifest <org.yaml>                      Publish a new ownership manifest to all members

Every developer:
  join <invite-code> [--name N]                Create your keys and request membership
  run                                          Keep your node connected: realtime sync, indexing, auto-responder, dashboard
  mcp [--agent A] [--component C]              Stdio MCP server for your coding agent (configure it in your agent)
  status | sync | index
  queue                                        Items waiting for your approval
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
            'bootstrap-token': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [command, sub, arg, arg2] = positionals;
    if (!command || values.help || command === 'help')
        return void process.stdout.write(HELP);
    const home = homeDir(values.home);
    const admin = await import('./node/admin.js');
    const { LocalNode } = await import('./node/node.js');
    if (command === 'org' && sub === 'init') {
        const { loadManifest } = await import('./config.js');
        const token = values['bootstrap-token'] ?? process.env.BOOTSTRAP_TOKEN;
        if (!values.hub || !values.org || !values.developer || !values.manifest || !token) {
            throw new Error('usage: org init --hub URL --org ID --developer ID --manifest org.yaml   (and BOOTSTRAP_TOKEN)');
        }
        if (LocalNode.exists(home))
            throw new Error(`A node already exists in ${home}. Use --home to choose another directory.`);
        const { node, fingerprint } = await admin.initOrg({ home, hub: values.hub, org: values.org, developer: values.developer, name: values.name, manifest: loadManifest(values.manifest), bootstrapToken: token });
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
            'Tell your admin your fingerprint so they can verify it, then run "agent-network run".');
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
        const repository = Object.entries(node.settings.repositories).find(([, r]) => r.path && (cwd + sep).startsWith(resolve(node.settings.baseDir, r.path) + sep))?.[0] ?? null;
        const session = new AgentSession(node, { agent: values.agent ?? process.env.AGENT_NETWORK_AGENT ?? 'agent', component: values.component ?? null, repository });
        switch (command) {
            case 'mcp': {
                const { serveStdio } = await import('./mcp.js');
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
                    members: node.ctx.db.all("SELECT id, status, fingerprint FROM members ORDER BY id"),
                    last_sync: node.state('last_pull'),
                    realtime: node.daemonAlive(),
                    pending_outbound: node.ctx.db.get("SELECT count(*) AS n FROM outbox WHERE state = 'pending'").n,
                });
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