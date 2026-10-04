import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { resolveFrom } from '../config.js';
import { detectConflicts } from '../conflicts.js';
import { currentEntries, retireEntry, upsertEntry } from '../context.js';
import { contractFacts, diffContracts, parseOpenApi } from '../contracts.js';
import { applyCodeowners, parseCodeowners, storeCodeowners } from '../registry.js';
import { endpointKey } from '../subjects.js';
import { SYSTEM_IDENTITY } from '../types.js';
import { insideRoots } from '../scope.js';
import { fromJson, iso, unique } from '../util.js';
const exec = promisify(execFile);
async function git(cwd, args) {
    const { stdout } = await exec('git', args, { cwd, timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
}
/** Returns a working directory for the repository: the local path, or a shallow clone of the remote. */
async function checkout(ctx, repo) {
    const settings = ctx.config.repositories[repo.id];
    if (!settings)
        throw new Error(`repository ${repo.id} is not configured`);
    if (settings.path) {
        const dir = resolveFrom(ctx.config, settings.path);
        if (!existsSync(dir))
            throw new Error(`path not found: ${dir}`);
        if (ctx.config.scope_roots && !insideRoots(ctx.config.scope_roots, dir)) {
            throw new Error(`${dir} is outside every project, so it was not read. Add it with "agent-network project add".`);
        }
        const commit = await git(dir, ['rev-parse', 'HEAD']).catch(() => null);
        return { dir, commit };
    }
    const dir = join(resolveFrom(ctx.config, ctx.config.repo_cache), repo.id);
    if (existsSync(join(dir, '.git'))) {
        await git(dir, ['fetch', '--depth', '1', 'origin', settings.branch ?? 'HEAD']);
        await git(dir, ['reset', '--hard', 'FETCH_HEAD']);
    }
    else {
        mkdirSync(dirname(dir), { recursive: true });
        await git(dirname(dir), ['clone', '--depth', '1', ...(settings.branch ? ['--branch', settings.branch] : []), settings.url, dir]);
    }
    return { dir, commit: await git(dir, ['rev-parse', 'HEAD']) };
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next']);
const SPEC_FILE = /^(?:(?:openapi|swagger)(?:[.-][\w.-]*)?|[\w.-]+\.(?:openapi|swagger))\.(?:ya?ml|json)$/i;
function discoverSpecs(root, exclude, depth = 0, found = []) {
    if (depth > 6 || !existsSync(root))
        return found;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && !exclude.includes(full))
                discoverSpecs(full, exclude, depth + 1, found);
        }
        else if (SPEC_FILE.test(entry.name)) {
            found.push(full);
        }
    }
    return found;
}
const posix = (path) => path.split(sep).join('/');
export async function indexRepository(ctx, repo) {
    const report = { repository: repo.id, commit: null, components: [], codeowners_rules: 0, conflicts: [], contract_changes: [] };
    let dir;
    try {
        const checkedOut = await checkout(ctx, repo);
        dir = checkedOut.dir;
        report.commit = checkedOut.commit;
    }
    catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        ctx.db.run('UPDATE repositories SET index_error = :error WHERE id = :id', { error: report.error, id: repo.id });
        return report;
    }
    // Everything below is synchronous, so a single transaction keeps the index consistent.
    ctx.db.tx(() => {
        const codeownersFile = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']
            .map((p) => join(dir, p))
            .find((file) => existsSync(file) && insideRoots([dir], file));
        const rules = codeownersFile ? parseCodeowners(readFileSync(codeownersFile, 'utf8')) : [];
        storeCodeowners(ctx, repo.id, rules);
        applyCodeowners(ctx, repo.id);
        report.codeowners_rules = rules.length;
        const components = ctx.db.all('SELECT * FROM components WHERE repository_id = :id ORDER BY id', { id: repo.id });
        const factSubjects = [];
        for (const component of components) {
            const base = join(dir, component.path ?? '');
            const nested = components
                .filter((c) => c.id !== component.id && c.path && (!component.path || c.path.startsWith(`${component.path}/`)))
                .map((c) => join(dir, c.path));
            const configured = ctx.config.components[component.id]?.openapi;
            const specFiles = (configured ? configured.map((f) => join(base, f)) : discoverSpecs(base, nested)).filter((file) => insideRoots([dir], file));
            const summary = { component: component.id, spec_files: specFiles.map((f) => posix(relative(dir, f))), endpoints: 0, changed: 0, removed: 0, warnings: [] };
            const seenSlots = new Set();
            let allParsed = true;
            for (const file of specFiles) {
                const rel = posix(relative(dir, file));
                let contracts;
                try {
                    contracts = parseOpenApi(parseYaml(readFileSync(file, 'utf8'))).contracts;
                }
                catch (error) {
                    allParsed = false;
                    summary.warnings.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                for (const contract of contracts) {
                    const key = endpointKey(contract.method, contract.path);
                    const slot = `api_contract|openapi|${key}|${component.id}`;
                    seenSlots.add(slot);
                    summary.endpoints++;
                    const result = upsertEntry(ctx, {
                        subject: `${contract.method} ${contract.path}`,
                        component_id: component.id,
                        type: 'api_contract',
                        title: contract.summary ?? contract.operation_id ?? null,
                        data: contract,
                        source_kind: 'openapi',
                        source_ref: `${repo.id}:${rel}`,
                        commit: report.commit,
                        slot,
                        facts: contractFacts(contract).map((f) => ({ ...f, evidence: `${rel} ${contract.method} ${contract.path}` })),
                    });
                    factSubjects.push(...result.factSubjects);
                    if (result.changed && result.previous) {
                        summary.changed++;
                        const changes = diffContracts(fromJson(result.previous.data, contract), contract);
                        if (changes.length)
                            report.contract_changes.push({ subject: result.entry.subject, key, component: component.id, changes });
                    }
                }
            }
            // Endpoints that disappeared from the spec are retired, which is a breaking change for consumers.
            if (allParsed) {
                for (const entry of currentEntries(ctx, { componentId: component.id, type: 'api_contract', sourceKind: 'openapi' })) {
                    if (seenSlots.has(entry.slot))
                        continue;
                    summary.removed++;
                    factSubjects.push(...retireEntry(ctx, entry));
                    report.contract_changes.push({
                        subject: entry.subject,
                        key: entry.subject_key,
                        component: component.id,
                        changes: [{ severity: 'breaking', location: 'endpoint', change: 'endpoint removed from the OpenAPI spec' }],
                    });
                }
            }
            report.components.push(summary);
        }
        const conflicts = detectConflicts(ctx, unique(factSubjects), { ...SYSTEM_IDENTITY, agent: 'indexer', repository: repo.id });
        report.conflicts = conflicts.filter((c) => c.state !== 'resolved').map((c) => c.id);
        ctx.db.run('UPDATE repositories SET head_commit = :commit, indexed_at = :now, index_error = NULL WHERE id = :id', {
            commit: report.commit,
            now: iso(ctx.now()),
            id: repo.id,
        });
    });
    return report;
}
//# sourceMappingURL=repository.js.map