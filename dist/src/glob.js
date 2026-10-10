/**
 * Minimal glob matching for relationship scopes. Paths are POSIX-style and relative to the component directory.
 *   `*`  any characters except "/"      `**`  any characters including "/"      `?`  one character except "/"
 * A pattern with no wildcard and no trailing slash matches that file; `dir/` and `dir` also match everything below `dir`.
 */
const cache = new Map();
function toRegExp(pattern) {
    let regex = cache.get(pattern);
    if (regex)
        return regex;
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    let source = '';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === '*') {
            if (normalized[i + 1] === '*') {
                i++;
                // "**/" matches zero or more directories
                if (normalized[i + 1] === '/') {
                    i++;
                    source += '(?:.*/)?';
                }
                else
                    source += '.*';
            }
            else
                source += '[^/]*';
        }
        else if (char === '?')
            source += '[^/]';
        else
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    // A plain folder name (or "folder/") covers everything under it.
    const folder = !/[*?]/.test(normalized) ? `(?:/.*)?` : '';
    regex = new RegExp(`^${source.replace(/\/$/, '')}${folder}$`, 'i');
    cache.set(pattern, regex);
    return regex;
}
export function matchesGlob(pattern, relativePath) {
    return toRegExp(pattern).test(relativePath.replace(/\\/g, '/').replace(/^\.\//, ''));
}
export function matchesAny(patterns, relativePath) {
    return patterns.some((pattern) => matchesGlob(pattern, relativePath));
}
/** True when the scope is the whole component, written on purpose as `**`. */
export function isWholeComponent(scope) {
    return scope.some((pattern) => pattern.trim() === '**' || pattern.trim() === '**/*');
}
//# sourceMappingURL=glob.js.map