import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'ids may contain letters, digits, ".", "_" and "-"');
// ---------------------------------------------------------------------------
// Org manifest: the ownership model, authored by the org admin and distributed signed + encrypted.
// ---------------------------------------------------------------------------
const TeamSchema = z.object({
    name: z.string().optional(),
    /** GitHub team handle used in CODEOWNERS, e.g. "@acme/backend". */
    github_team: z.string().optional(),
});
const DeveloperSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    /** GitHub username used in CODEOWNERS, without "@". */
    github: z.string().optional(),
    teams: z.array(id).default([]),
    admin: z.boolean().default(false),
});
const ComponentSchema = z.object({
    team: id,
    owners: z.array(id).default([]),
    description: z.string().optional(),
    aliases: z.array(z.string()).default([]),
    /** Logical repository id; each developer maps it to a local checkout in their node config. */
    repository: id.optional(),
    /** Sub-directory of the repository for monorepos. */
    path: z.string().optional(),
    /** OpenAPI files relative to the component directory. Discovered automatically when omitted. */
    openapi: z.array(z.string()).optional(),
    /** "restricted" components are only visible (and only encrypted for) their team, owners and reader teams. */
    visibility: z.enum(['org', 'restricted']).default('org'),
    readers: z.array(id).default([]),
    /** APIs or components this component depends on, e.g. "GET /api/resources/{id}" or "resource-service". */
    consumes: z.array(z.string()).default([]),
});
export const ManifestSchema = z.object({
    organization: z.string().optional(),
    teams: z.record(id, TeamSchema).default({}),
    developers: z.record(id, DeveloperSchema).default({}),
    components: z.record(id, ComponentSchema).default({}),
    /**
     * Experiment orgs only: admin members who receive a sealed copy of every message and write it to a trace. This is a
     * deliberate break of "the relay and other members cannot read your messages", so it is visible: observers appear in every
     * message's audience and in the agents' instructions.
     */
    observers: z.array(id).default([]),
});
/** Parses and cross-validates a manifest; throws with every problem listed. */
export function validateManifest(raw) {
    const parsed = ManifestSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
        throw new Error(`Invalid manifest:\n${issues.join('\n')}`);
    }
    const manifest = parsed.data;
    const problems = [];
    const teams = new Set(Object.keys(manifest.teams));
    const developers = new Set(Object.keys(manifest.developers));
    const components = new Set(Object.keys(manifest.components));
    for (const [devId, dev] of Object.entries(manifest.developers)) {
        for (const team of dev.teams)
            if (!teams.has(team))
                problems.push(`developers.${devId}: unknown team "${team}"`);
    }
    const aliases = new Map();
    for (const [compId, comp] of Object.entries(manifest.components)) {
        if (!teams.has(comp.team))
            problems.push(`components.${compId}: unknown team "${comp.team}"`);
        for (const owner of comp.owners)
            if (!developers.has(owner))
                problems.push(`components.${compId}: unknown owner "${owner}"`);
        for (const reader of comp.readers)
            if (!teams.has(reader))
                problems.push(`components.${compId}: unknown reader team "${reader}"`);
        for (const alias of comp.aliases) {
            const key = alias.toLowerCase();
            const other = aliases.get(key);
            if (components.has(alias) && alias !== compId)
                problems.push(`components.${compId}: alias "${alias}" is a component id`);
            else if (other && other !== compId)
                problems.push(`components.${compId}: alias "${alias}" also used by ${other}`);
            aliases.set(key, compId);
        }
    }
    for (const observer of manifest.observers) {
        if (!developers.has(observer))
            problems.push(`observers: unknown developer "${observer}"`);
        else if (!manifest.developers[observer].admin)
            problems.push(`observers: "${observer}" must be an admin`);
    }
    if (problems.length)
        throw new Error(`Invalid manifest:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return manifest;
}
export function loadManifest(path) {
    return validateManifest(parseYaml(readFileSync(resolve(path), 'utf8')));
}
// ---------------------------------------------------------------------------
// Node configuration: what one developer's machine indexes and how it behaves. Never leaves the machine.
// ---------------------------------------------------------------------------
const RepositorySchema = z
    .object({
    path: z.string().optional(),
    url: z.string().optional(),
    branch: z.string().optional(),
})
    .refine((repo) => repo.path || repo.url, 'a repository needs "path" (local checkout) or "url" (git remote)');
const TaskSourceSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('file'), path: z.string() }),
    z.object({
        type: z.literal('jira'),
        base_url: z.string(),
        jql: z.string(),
        email_env: z.string().default('JIRA_EMAIL'),
        token_env: z.string().default('JIRA_API_TOKEN'),
        /** Jira component name -> component id. Jira components with the same name as a component map automatically. */
        component_map: z.record(z.string(), z.string()).default({}),
        max_results: z.number().int().positive().default(500),
    }),
    z.object({
        type: z.literal('linear'),
        token_env: z.string().default('LINEAR_API_KEY'),
        team_keys: z.array(z.string()).default([]),
        /** Linear team key -> component id. */
        team_map: z.record(z.string(), z.string()).default({}),
        max_results: z.number().int().positive().default(500),
    }),
]);
/**
 * A project is the unit of scope: the folders an agent may look at, and a short description so it does not have to
 * explore to find out what the project is. Paths are machine-specific, so projects live in the node config.
 */
const ProjectSchema = z.object({
    /** What the project is and does, in plain words. Shown to agents so they do not need to explore. */
    description: z.string().default(''),
    /** One or more folders (absolute, or relative to the node directory). */
    paths: z.array(z.string().min(1)).min(1),
    /** Logical repository id from the org manifest; makes this project the local checkout for that repository. */
    repository: id.optional(),
    /** Anything an agent should know up front: how to build and test, entry points, conventions. */
    notes: z.string().optional(),
});
/** A named group of projects an agent works across, e.g. a product made of several repositories. */
const WorkspaceSchema = z.object({
    description: z.string().default(''),
    projects: z.array(id).min(1),
});
export const RUNTIME_TOOLS = ['claude-code', 'codex', 'antigravity', 'gemini', 'opencode', 'custom', 'api'];
/**
 * How the node runs an agent by itself (answering urgent questions, keeping memory up to date). This never affects
 * your own interactive agent. The model is always an explicit choice: there is no silent default.
 */
const AgentProfileSchema = z
    .object({
    tool: z.enum(RUNTIME_TOOLS),
    /** Model name or alias for the tool. "default" deliberately uses whatever the tool is configured with. */
    model: z.string().min(1).optional(),
    /** tool "custom": the full command. "{model}" is replaced by the model. */
    command: z.array(z.string()).optional(),
    /** Extra arguments appended to a preset's command. */
    args: z.array(z.string()).default([]),
    /** tool "api": an OpenAI-compatible endpoint (also private or self-hosted models) or the Anthropic API. */
    provider: z.enum(['openai-compatible', 'anthropic']).optional(),
    base_url: z.string().url().optional(),
    /** Name of the environment variable holding the API key. Keys never live in this file. */
    api_key_env: z.string().optional(),
    max_tokens: z.number().int().positive().default(1024),
    timeout_seconds: z.number().int().positive().default(120),
})
    .superRefine((profile, ctx) => {
    if (profile.tool === 'custom') {
        if (!profile.command?.length)
            ctx.addIssue({ code: 'custom', path: ['command'], message: 'a "custom" tool needs the full command' });
        return;
    }
    if (!profile.model)
        ctx.addIssue({ code: 'custom', path: ['model'], message: 'choose a model (use "default" to deliberately use the tool\'s own default)' });
    if (profile.tool === 'api') {
        if (!profile.provider)
            ctx.addIssue({ code: 'custom', path: ['provider'], message: 'an "api" tool needs a provider (openai-compatible or anthropic)' });
        if (profile.provider === 'openai-compatible' && !profile.base_url)
            ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'an openai-compatible endpoint needs base_url' });
    }
});
export const NodeConfigSchema = z.object({
    /** Hub base URL, e.g. https://agent-network-hub.<account>.workers.dev */
    hub: z.string().url(),
    org: z.string(),
    developer: id,
    identity: z.string().default('identity.json'),
    database: z.string().default('graph.db'),
    /**
     * Observer node (experiments): messages are written to the trace instead of the inbox, and nothing is acted on.
     * Only meaningful for a member the manifest lists under `observers`.
     */
    observer: z.boolean().default(false),
    repo_cache: z.string().default('repos'),
    /** Local checkouts this developer's node indexes and publishes (usually the components they own). */
    repositories: z.record(id, RepositorySchema).default({}),
    /** What agents may look at. When any project is defined, nothing outside the projects is indexed or served. */
    projects: z.record(id, ProjectSchema).default({}),
    workspaces: z.record(id, WorkspaceSchema).default({}),
    /** The workspace agents are oriented to. Without it, every project is in scope. */
    workspace: id.optional(),
    /** Named ways to run an agent from the node: pick the tool and model per job. */
    agents: z.object({ profiles: z.record(id, AgentProfileSchema).default({}) }).prefault({}),
    tasks: z.array(TaskSourceSchema).default([]),
    policy: z
        .object({
        /**
         * How shared memory updates from other members are applied:
         *  - owner_authoritative: updates about a component from its owning team apply automatically; others wait for approval
         *  - all: apply everything from verified members
         *  - manual: every update waits for developer approval
         */
        apply_updates: z.enum(['owner_authoritative', 'all', 'manual']).default('owner_authoritative'),
    })
        .prefault({}),
    responder: z
        .object({
        /** Answer urgent enquiries while the developer is away by running a read-only headless agent. */
        enabled: z.boolean().default(false),
        /** Which entry of agents.profiles runs it. Preferred: the command is built, scoped and read-only. */
        profile: id.optional(),
        /** Raw command and arguments (advanced; used when no profile is set). The prompt is written to stdin. */
        command: z.array(z.string()).default([]),
        timeout_seconds: z.number().int().positive().default(120),
        max_per_hour: z.number().int().positive().default(20),
        max_per_day: z.number().int().positive().default(100),
    })
        .prefault({}),
    dashboard: z
        .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().default(7421),
    })
        .prefault({}),
    index: z.object({ interval_minutes: z.number().min(0).default(15) }).prefault({}),
    sync: z.object({ poll_seconds: z.number().positive().default(30) }).prefault({}),
    freshness: z.object({ max_age_days: z.number().positive().default(30) }).prefault({}),
    /**
     * How long `ask` waits for an answer when the agent does not say. An agent that is not given the answer tends to carry on with a
     * guess and finish before it arrives (docs/results/E1-pilot.md, F-04 and F-09), so the default is to wait.
     */
    ask: z.object({ default_wait_seconds: z.number().min(0).max(120).default(30) }).prefault({}),
});
export function parseNodeConfig(raw, baseDir) {
    const parsed = NodeConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
        throw new Error(`Invalid node configuration:\n${issues.join('\n')}`);
    }
    const settings = { ...parsed.data, baseDir };
    const problems = crossCheckNodeConfig(settings);
    if (problems.length)
        throw new Error(`Invalid node configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return settings;
}
/** Everything the schema cannot express on its own: references between sections and the project boundary. */
function crossCheckNodeConfig(settings) {
    const problems = [];
    for (const [name, workspace] of Object.entries(settings.workspaces)) {
        for (const project of workspace.projects)
            if (!settings.projects[project])
                problems.push(`workspaces.${name}: unknown project "${project}"`);
    }
    if (settings.workspace && !settings.workspaces[settings.workspace])
        problems.push(`workspace: unknown workspace "${settings.workspace}"`);
    if (settings.responder.profile && !settings.agents.profiles[settings.responder.profile]) {
        problems.push(`responder.profile: unknown profile "${settings.responder.profile}" (define it under agents.profiles)`);
    }
    const roots = projectRoots(settings);
    if (roots) {
        for (const [name, repo] of Object.entries(settings.repositories)) {
            if (repo.path && !roots.some((root) => pathInside(root, resolveFrom(settings, repo.path)))) {
                problems.push(`repositories.${name}: ${repo.path} is outside every project. Add it as a project (agent-network project add) so agents may look there.`);
            }
        }
    }
    return problems;
}
/** True when `candidate` is `root` or lies below it. Case-insensitive on Windows. */
export function pathInside(root, candidate) {
    const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const rel = relative(norm(root), norm(candidate));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** Absolute folders agents may use, or null when no project is defined (nothing is scoped yet). */
export function projectRoots(settings) {
    const projects = Object.values(settings.projects);
    if (projects.length === 0)
        return null;
    return projects.flatMap((project) => project.paths.map((p) => resolveFrom(settings, p)));
}
export function loadNodeConfig(path) {
    const absolute = resolve(path);
    let text;
    try {
        text = readFileSync(absolute, 'utf8');
    }
    catch {
        throw new Error(`Node configuration not found: ${absolute}\nRun "agent-network join <invite>" or "agent-network org init" first.`);
    }
    return parseNodeConfig(parseYaml(text), dirname(absolute));
}
export function composeConfig(manifest, node) {
    // A project that names a repository is that repository's local checkout.
    const repositories = { ...node.repositories };
    for (const project of Object.values(node.projects ?? {})) {
        if (project.repository && !repositories[project.repository])
            repositories[project.repository] = { path: project.paths[0] };
    }
    return {
        baseDir: node.baseDir,
        organization: manifest?.organization ?? node.org,
        teams: manifest?.teams ?? {},
        developers: manifest?.developers ?? {},
        components: manifest?.components ?? {},
        repositories,
        tasks: node.tasks,
        repo_cache: node.repo_cache,
        freshness: node.freshness,
        routing: { online_window_minutes: 10 },
        scope_roots: projectRoots({ baseDir: node.baseDir, projects: node.projects ?? {} }),
    };
}
export function resolveFrom(config, path) {
    return isAbsolute(path) ? path : resolve(config.baseDir, path);
}
//# sourceMappingURL=config.js.map