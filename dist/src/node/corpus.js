/**
 * The scoped answering folder. A relationship that limits answers to some files is enforced by construction: the files that match
 * the scope are copied (secrets redacted, secret-looking files left out) into a fresh folder outside the repository, and the
 * answering agent is started there and nowhere else. It cannot quote what was never put in front of it.
 *
 * Known limit: an agent that can read the whole disk could still walk out of the folder. The folder is therefore created with
 * nothing else in it, and the agent's prompt names it as the only source; interactive agents are covered by approval instead.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { matchesAny } from '../glob.js';
import { looksLikeSecretFile, redactSecrets } from '../secrets.js';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);
function* walk(base, rel = '') {
    for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        // Symbolic links are never followed: a link inside the component could otherwise lead out of it.
        if (entry.isSymbolicLink())
            continue;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name))
                yield* walk(base, path);
        }
        else if (entry.isFile())
            yield path;
    }
}
export function buildCorpus(options) {
    const { base, scope, canaries = [], maxFiles = 400, maxFileBytes = 200_000, maxTotalBytes = 3_000_000 } = options;
    // The real path, so that Windows short (8.3) temporary folder names, which some agent sandboxes cannot read, are not used.
    const root = options.root ?? realpathSync.native(tmpdir());
    mkdirSync(root, { recursive: true });
    const dir = realpathSync.native(mkdtempSync(join(root, 'cm-answer-')));
    const files = [];
    const excluded = [];
    const redacted = [];
    let total = 0;
    try {
        for (const path of walk(base)) {
            if (!matchesAny(scope, path))
                continue;
            if (looksLikeSecretFile(path)) {
                excluded.push({ path, reason: 'secret by name' });
                continue;
            }
            const size = lstatSync(join(base, path)).size;
            if (size > maxFileBytes) {
                excluded.push({ path, reason: 'too large' });
                continue;
            }
            if (files.length >= maxFiles || total + size > maxTotalBytes) {
                excluded.push({ path, reason: 'corpus size limit' });
                continue;
            }
            const buffer = readFileSync(join(base, path));
            if (buffer.includes(0)) {
                excluded.push({ path, reason: 'binary' });
                continue;
            }
            const { text, hits } = redactSecrets(buffer.toString('utf8'), canaries);
            if (hits.length)
                redacted.push(path);
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), text);
            files.push(path);
            total += size;
        }
    }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return {
        dir,
        files,
        excluded,
        redacted,
        cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
    };
}
/**
 * Removes the path of the working folder from an answer. The model quotes the paths it saw, and a path such as
 * C:\Users\alice\AppData\Local\Temp\cm-answer-x\src\a.ts tells the asker the owner's user name and folder layout. Each folder's path
 * becomes ".", so "src/a.ts:4" stays a usable reference. Matches the native, forward-slash and escaped-backslash spellings,
 * ignoring case (Windows).
 */
export function scrubPaths(text, dirs) {
    let out = text;
    for (const dir of dirs) {
        if (dir.length < 6)
            continue;
        const spellings = new Set([dir, dir.replaceAll('\\', '/'), dir.replaceAll('\\', '\\\\')]);
        for (const spelling of spellings)
            out = out.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '.');
    }
    return out;
}
//# sourceMappingURL=corpus.js.map