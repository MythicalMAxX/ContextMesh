/**
 * Project scope: which folders an agent may look at, and the short map that saves it from exploring.
 *
 * The node cannot sandbox an agent it did not start (that is up to the agent's own permissions), so scope works in
 * layers: agents are told their boundary up front (MCP instructions and `orient`), agent rules and permissions can be
 * generated from it, and everything the node itself reads or launches is confined to it.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse, resolve, sep } from 'node:path';
import { pathInside, resolveFrom } from './config.js';
import { invalid } from './errors.js';
export function resolveProject(settings, name) {
    const project = settings.projects[name];
    if (!project)
        return null;
    return {
        name,
        description: project.description,
        paths: project.paths.map((p) => resolveFrom(settings, p)),
        repository: project.repository ?? null,
        notes: project.notes ?? null,
    };
}
/** Projects in scope: the active workspace's, or all of them when no workspace is selected. */
export function activeProjects(settings) {
    const names = settings.workspace ? (settings.workspaces[settings.workspace]?.projects ?? []) : Object.keys(settings.projects);
    return names.map((name) => resolveProject(settings, name)).filter((p) => !!p);
}
export function scopeRoots(settings) {
    return activeProjects(settings).flatMap((p) => p.paths);
}
/** The real path (symlinks and Windows short names resolved) when the folder exists, otherwise the resolved path. */
export function canonical(path) {
    try {
        return realpathSync.native(resolve(path));
    }
    catch {
        return resolve(path);
    }
}
/** The project whose folder contains `dir` (the most specific one wins). */
export function currentProject(settings, dir) {
    const where = canonical(dir);
    let best = null;
    for (const project of activeProjects(settings)) {
        for (const path of project.paths) {
            const root = canonical(path);
            if (pathInside(root, where) && (!best || root.length > best.length))
                best = { project, length: root.length };
        }
    }
    return best?.project ?? null;
}
/**
 * True when `candidate` is inside one of `roots` after resolving symlinks, so a link inside a project cannot be used to
 * reach files outside it. Paths that do not exist yet are judged by their parent folder.
 */
export function insideRoots(roots, candidate) {
    const real = (path) => {
        let current = resolve(path);
        const tail = [];
        while (!existsSync(current)) {
            const parent = resolve(current, '..');
            if (parent === current)
                return resolve(path);
            tail.unshift(current.slice(parent.length + 1));
            current = parent;
        }
        return resolve(realpathSync.native(current), ...tail);
    };
    const target = real(candidate);
    return roots.some((root) => pathInside(real(root), target));
}
/**
 * Refuses folders so broad that "this project" would mean "my computer": a drive root, the home folder, or any folder
 * that contains the home folder. Returns the resolved absolute path.
 */
export function validateProjectPath(path, base = process.cwd()) {
    const absolute = resolve(base, path);
    if (!existsSync(absolute))
        throw invalid(`Folder not found: ${absolute}`);
    if (!statSync(absolute).isDirectory())
        throw invalid(`Not a folder: ${absolute}`);
    const real = realpathSync.native(absolute);
    const home = realpathSync.native(homedir());
    if (parse(real).root === real)
        throw invalid(`${absolute} is a whole drive. Choose the folder of one project.`);
    if (pathInside(real, home)) {
        throw invalid(`${absolute} is your home folder or contains it, so an agent would be free to read everything in it. Choose the folder of one project.`);
    }
    return real;
}
/** Plain-language rules every agent gets, whatever tool it runs in. */
export function scopeRules(roots) {
    if (roots.length === 0) {
        return ['No project is set up yet. Ask your developer to run `agent-network setup` so you know which folders to work in; until then, do not search outside the current directory.'];
    }
    return [
        `Work only inside: ${roots.join(', ')}.`,
        'Do not list, search or read files outside those folders (no home folder, no whole-drive searches). If something you need is elsewhere, ask your developer to add it as a project instead of looking for it.',
        'Start from the project descriptions and notes above; open only the files you need rather than scanning the repository.',
    ];
}
/** Markdown block for CLAUDE.md, AGENTS.md or .cursor/rules, so the boundary also holds when this MCP server is not in use. */
export function scopeRuleBlock(projects) {
    const lines = ['<!-- agent-network:scope:start -->', '## Project scope', ''];
    for (const project of projects) {
        lines.push(`- **${project.name}**${project.description ? `: ${project.description}` : ''}`);
        for (const path of project.paths)
            lines.push(`  - \`${path.split(sep).join('/')}\``);
        if (project.notes)
            lines.push(`  - ${project.notes.replace(/\s+/g, ' ').trim()}`);
    }
    lines.push('', ...scopeRules(projects.flatMap((p) => p.paths)).map((rule) => `- ${rule}`), '<!-- agent-network:scope:end -->');
    return lines.join('\n');
}
export const SCOPE_MARKERS = ['<!-- agent-network:scope:start -->', '<!-- agent-network:scope:end -->'];
//# sourceMappingURL=scope.js.map