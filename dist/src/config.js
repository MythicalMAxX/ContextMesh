import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
export const NodeConfigSchema = z.object({
    /** Hub base URL, e.g. https://agent-network-hub.<account>.workers.dev */
    hub: z.string().url(),
    org: z.string(),
    developer: id,
    identity: z.string().default('identity.json'),
    database: z.string().default('graph.db'),
    repo_cache: z.string().default('repos'),
    /** Local checkouts this developer's node indexes and publishes (usually the components they own). */
    repositories: z.record(id, RepositorySchema).default({}),
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
        /** Command and arguments; the enquiry prompt is written to stdin and the answer read from stdout. */
        command: z.array(z.string()).default([]),
        timeout_seconds: z.number().int().positive().default(120),
        max_per_hour: z.number().int().positive().default(20),
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
});
export function parseNodeConfig(raw, baseDir) {
    const parsed = NodeConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
        throw new Error(`Invalid node configuration:\n${issues.join('\n')}`);
    }
    return { ...parsed.data, baseDir };
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
    return {
        baseDir: node.baseDir,
        organization: manifest?.organization ?? node.org,
        teams: manifest?.teams ?? {},
        developers: manifest?.developers ?? {},
        components: manifest?.components ?? {},
        repositories: node.repositories,
        tasks: node.tasks,
        repo_cache: node.repo_cache,
        freshness: node.freshness,
        routing: { online_window_minutes: 10 },
    };
}
export function resolveFrom(config, path) {
    return isAbsolute(path) ? path : resolve(config.baseDir, path);
}
//# sourceMappingURL=config.js.map