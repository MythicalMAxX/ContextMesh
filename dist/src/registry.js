import { forbidden, notFound } from './errors.js';
import { endpointMatches, matchScore, parseEndpoint, subjectKey, tokens } from './subjects.js';
import { fromJson, iso, toJson, unique } from './util.js';
// ---------------------------------------------------------------------------
// Configuration sync
// ---------------------------------------------------------------------------
/** Mirrors the ownership model from configuration into the database. Indexed data is preserved. */
export function syncConfig(ctx) {
    const { db, config } = ctx;
    db.tx(() => {
        for (const table of ['team_members', 'teams', 'developers', 'components', 'component_aliases', 'component_readers']) {
            db.run(`DELETE FROM ${table}`);
        }
        db.run("DELETE FROM component_owners WHERE source = 'config'");
        db.run("DELETE FROM edges WHERE source = 'config'");
        for (const [id, team] of Object.entries(config.teams)) {
            db.run('INSERT INTO teams (id, name, github_team) VALUES (:id, :name, :github)', {
                id,
                name: team.name ?? id,
                github: team.github_team ?? null,
            });
        }
        for (const [id, dev] of Object.entries(config.developers)) {
            db.run('INSERT INTO developers (id, name, email, github, admin) VALUES (:id, :name, :email, :github, :admin)', {
                id,
                name: dev.name ?? id,
                email: dev.email ?? null,
                github: dev.github ?? null,
                admin: dev.admin,
            });
            for (const team of dev.teams) {
                db.run('INSERT INTO team_members (team_id, developer_id) VALUES (:team, :id)', { team, id });
            }
        }
        for (const [id, comp] of Object.entries(config.components)) {
            db.run(`INSERT INTO components (id, team_id, description, repository_id, path, visibility)
         VALUES (:id, :team, :description, :repository, :path, :visibility)`, {
                id,
                team: comp.team,
                description: comp.description ?? null,
                repository: comp.repository ?? null,
                path: comp.path ?? null,
                visibility: comp.visibility,
            });
            for (const owner of comp.owners) {
                db.run("INSERT INTO component_owners (component_id, developer_id, source) VALUES (:id, :owner, 'config')", {
                    id,
                    owner,
                });
            }
            for (const alias of comp.aliases) {
                db.run('INSERT INTO component_aliases (alias, component_id) VALUES (:alias, :id)', { alias, id });
            }
            for (const team of comp.readers) {
                db.run('INSERT INTO component_readers (component_id, team_id) VALUES (:id, :team)', { id, team });
            }
            for (const dependency of comp.consumes) {
                const target = config.components[dependency] ? dependency : subjectKey(dependency);
                addEdge(ctx, 'component', id, 'consumes', config.components[dependency] ? 'component' : 'subject', target, 'config');
            }
        }
        const repoIds = Object.keys(config.repositories);
        db.run("DELETE FROM repositories WHERE location NOT LIKE 'remote:%' AND id NOT IN (SELECT value FROM json_each(:ids))", { ids: toJson(repoIds) });
        for (const [id, repo] of Object.entries(config.repositories)) {
            db.run(`INSERT INTO repositories (id, location, branch) VALUES (:id, :location, :branch)
         ON CONFLICT(id) DO UPDATE SET location = excluded.location, branch = excluded.branch`, { id, location: repo.url ?? repo.path, branch: repo.branch ?? null });
        }
    });
}
export function addEdge(ctx, fromKind, fromId, rel, toKind, toId, source) {
    ctx.db.run(`INSERT OR IGNORE INTO edges (from_kind, from_id, rel, to_kind, to_id, source, created_at)
     VALUES (:fromKind, :fromId, :rel, :toKind, :toId, :source, :now)`, { fromKind, fromId, rel, toKind, toId, source, now: iso(ctx.now()) });
}
// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export function getComponent(ctx, idOrAlias) {
    return (ctx.db.get('SELECT * FROM components WHERE id = :id COLLATE NOCASE', { id: idOrAlias.trim() }) ??
        ctx.db.get('SELECT c.* FROM components c JOIN component_aliases a ON a.component_id = c.id WHERE a.alias = :alias', { alias: idOrAlias.trim() }));
}
export function requireComponent(ctx, idOrAlias) {
    const component = getComponent(ctx, idOrAlias);
    if (!component)
        throw notFound(`Unknown component "${idOrAlias}". Use find_owner to discover components.`);
    return component;
}
export function listComponents(ctx) {
    return ctx.db.all('SELECT * FROM components ORDER BY id');
}
export function getRepository(ctx, id) {
    return ctx.db.get('SELECT * FROM repositories WHERE id = :id', { id });
}
export function teamMembers(ctx, teamId) {
    return ctx.db
        .all('SELECT developer_id FROM team_members WHERE team_id = :teamId ORDER BY developer_id', {
        teamId,
    })
        .map((r) => r.developer_id);
}
export function developerTeams(ctx, developerId) {
    return ctx.db
        .all('SELECT team_id FROM team_members WHERE developer_id = :developerId ORDER BY team_id', {
        developerId,
    })
        .map((r) => r.team_id);
}
export function developerName(ctx, developerId) {
    return ctx.db.get('SELECT name FROM developers WHERE id = :id', { id: developerId })?.name ?? null;
}
/** Explicit owners from configuration win; then CODEOWNERS; then the whole owning team. */
export function componentOwners(ctx, componentId) {
    const rows = ctx.db.all('SELECT developer_id, source FROM component_owners WHERE component_id = :componentId ORDER BY developer_id', { componentId });
    const configured = rows.filter((r) => r.source === 'config').map((r) => r.developer_id);
    if (configured.length)
        return configured;
    const codeowners = unique(rows.map((r) => r.developer_id));
    if (codeowners.length)
        return codeowners;
    const component = ctx.db.get('SELECT * FROM components WHERE id = :componentId', { componentId });
    return component ? teamMembers(ctx, component.team_id) : [];
}
export function componentsOfTeam(ctx, teamId) {
    return ctx.db
        .all('SELECT id FROM components WHERE team_id = :teamId ORDER BY id', { teamId })
        .map((r) => r.id);
}
// ---------------------------------------------------------------------------
// Permissions: agents inherit the permissions of the developer they act for.
// ---------------------------------------------------------------------------
function isMemberOrOwner(ctx, identity, component) {
    return identity.teams.includes(component.team_id) || componentOwners(ctx, component.id).includes(identity.developer);
}
export function canRead(ctx, identity, componentId) {
    if (!componentId || identity.admin)
        return true;
    const component = ctx.db.get('SELECT * FROM components WHERE id = :componentId', { componentId });
    if (!component || component.visibility !== 'restricted')
        return true;
    if (isMemberOrOwner(ctx, identity, component))
        return true;
    const readers = ctx.db
        .all('SELECT team_id FROM component_readers WHERE component_id = :componentId', { componentId })
        .map((r) => r.team_id);
    return readers.some((team) => identity.teams.includes(team));
}
export function canWrite(ctx, identity, componentId) {
    if (identity.developer === 'system')
        return true;
    if (!componentId)
        return false;
    const component = ctx.db.get('SELECT * FROM components WHERE id = :componentId', { componentId });
    return component ? isMemberOrOwner(ctx, identity, component) : false;
}
export function assertRead(ctx, identity, componentId) {
    if (!canRead(ctx, identity, componentId)) {
        throw forbidden(`${identity.developer} does not have access to ${componentId}; its agent cannot either.`);
    }
}
export function assertWrite(ctx, identity, componentId, action) {
    if (!canWrite(ctx, identity, componentId)) {
        throw forbidden(`${identity.developer} cannot ${action} for ${componentId ?? 'an unowned subject'}: only the owning team can.`);
    }
}
/** Components the identity's developer owns or whose team they belong to. */
export function writableComponents(ctx, identity) {
    return listComponents(ctx)
        .filter((c) => isMemberOrOwner(ctx, identity, c))
        .map((c) => c.id);
}
// ---------------------------------------------------------------------------
// Presence: agents are "online" if they called the network recently.
// ---------------------------------------------------------------------------
export function touchPresence(ctx, identity) {
    if (identity.developer === 'system')
        return;
    ctx.db.run(`INSERT INTO presence (developer_id, agent, repository, component_id, last_seen)
     VALUES (:developer, :agent, :repository, :component, :now)
     ON CONFLICT(developer_id, agent, repository) DO UPDATE SET last_seen = excluded.last_seen, component_id = excluded.component_id`, {
        developer: identity.developer,
        agent: identity.agent,
        repository: identity.repository ?? '',
        component: identity.component,
        now: iso(ctx.now()),
    });
}
export function onlineAgents(ctx, developerIds) {
    const since = new Date(ctx.now().getTime() - ctx.config.routing.online_window_minutes * 60_000);
    return ctx.db
        .all(`SELECT developer_id, agent, repository, last_seen FROM presence
       WHERE developer_id IN (SELECT value FROM json_each(:ids)) AND last_seen >= :since ORDER BY last_seen DESC`, { ids: toJson(developerIds), since: iso(since) })
        .map((r) => ({ developer: r.developer_id, agent: r.agent, repository: r.repository || null, last_seen: r.last_seen }));
}
export function parseCodeowners(text) {
    const rules = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (!line || line.startsWith('['))
            continue; // skip comments and GitLab section headers
        const [pattern, ...owners] = line.split(/\s+/);
        rules.push({ pattern: pattern, owners });
    }
    return rules;
}
const escapeRegex = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
/** Converts a CODEOWNERS (gitignore-style) pattern into a regular expression over repository paths. */
export function codeownersRegex(pattern) {
    let p = pattern.trim();
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    if (p.startsWith('/'))
        p = p.slice(1);
    if (p.endsWith('/'))
        p = p.slice(0, -1);
    let body = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*' && p[i + 1] === '*') {
            if (p[i + 2] === '/') {
                body += '(?:.*/)?';
                i += 2;
            }
            else {
                body += '.*';
                i += 1;
            }
        }
        else if (c === '*')
            body += '[^/]*';
        else if (c === '?')
            body += '[^/]';
        else
            body += escapeRegex(c);
    }
    return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${body}(?:/.*)?$`);
}
/** Last matching rule wins, as on GitHub and GitLab. */
export function matchCodeowners(rules, filePath) {
    const path = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    let match;
    for (const rule of rules)
        if (codeownersRegex(rule.pattern).test(path))
            match = rule;
    return match;
}
export function storeCodeowners(ctx, repositoryId, rules) {
    ctx.db.run('DELETE FROM path_owners WHERE repository_id = :repositoryId', { repositoryId });
    rules.forEach((rule, position) => {
        ctx.db.run('INSERT INTO path_owners (repository_id, position, pattern, owners) VALUES (:repositoryId, :position, :pattern, :owners)', { repositoryId, position, pattern: rule.pattern, owners: toJson(rule.owners) });
    });
}
export function loadCodeowners(ctx, repositoryId) {
    return ctx.db
        .all('SELECT pattern, owners FROM path_owners WHERE repository_id = :repositoryId ORDER BY position', { repositoryId })
        .map((r) => ({ pattern: r.pattern, owners: fromJson(r.owners, []) }));
}
/** Maps CODEOWNERS entries (@user, @org/team, email) to developer ids. */
export function resolveOwnerHandles(ctx, handles) {
    const developers = [];
    for (const handle of handles) {
        if (handle.includes('@') && !handle.startsWith('@')) {
            const dev = ctx.db.get('SELECT id FROM developers WHERE email = :email COLLATE NOCASE', { email: handle });
            if (dev)
                developers.push(dev.id);
            continue;
        }
        const name = handle.replace(/^@/, '');
        if (name.includes('/')) {
            const team = ctx.db.get('SELECT id FROM teams WHERE github_team = :a COLLATE NOCASE OR github_team = :b COLLATE NOCASE', { a: handle, b: name });
            if (team)
                developers.push(...teamMembers(ctx, team.id));
            continue;
        }
        const dev = ctx.db.get('SELECT id FROM developers WHERE github = :name COLLATE NOCASE OR id = :name COLLATE NOCASE', { name });
        if (dev)
            developers.push(dev.id);
    }
    return unique(developers);
}
/** Derives component owners from CODEOWNERS for components that live in the repository. */
export function applyCodeowners(ctx, repositoryId) {
    const rules = loadCodeowners(ctx, repositoryId);
    const components = ctx.db.all('SELECT * FROM components WHERE repository_id = :repositoryId', {
        repositoryId,
    });
    for (const component of components) {
        ctx.db.run("DELETE FROM component_owners WHERE component_id = :id AND source = 'codeowners'", { id: component.id });
        const probe = component.path ? `${component.path.replace(/\/+$/, '')}/__probe__` : '__probe__';
        const rule = matchCodeowners(rules, probe);
        for (const developer of rule ? resolveOwnerHandles(ctx, rule.owners) : []) {
            ctx.db.run("INSERT OR IGNORE INTO component_owners (component_id, developer_id, source) VALUES (:id, :developer, 'codeowners')", { id: component.id, developer });
        }
    }
}
export function describeOwner(ctx, componentId) {
    const component = requireComponent(ctx, componentId);
    const owners = componentOwners(ctx, component.id);
    const team = ctx.db.get('SELECT name FROM teams WHERE id = :id', { id: component.team_id });
    return {
        component: component.id,
        owner_team: component.team_id,
        team_name: team?.name ?? null,
        owner: owners[0] ?? null,
        owners: owners.map((id) => ({ id, name: developerName(ctx, id) })),
        description: component.description,
        repository: component.repository_id,
        path: component.path,
        agents_online: onlineAgents(ctx, owners),
    };
}
/** The component that owns an endpoint, according to indexed or published contracts. */
export function endpointOwner(ctx, subject) {
    const ref = parseEndpoint(subject);
    if (!ref)
        return null;
    const rows = ctx.db.all(`SELECT DISTINCT subject_key, component_id, source_kind FROM context_entries
     WHERE subject_kind = 'endpoint' AND status = 'current' AND component_id IS NOT NULL AND type = 'api_contract'
     ORDER BY CASE source_kind WHEN 'openapi' THEN 0 ELSE 1 END`);
    const exact = rows.find((r) => endpointMatches(r.subject_key, ref));
    const loose = exact ?? rows.find((r) => endpointMatches(r.subject_key, ref, { ignoreVersion: true }));
    return loose ? { component: loose.component_id, key: loose.subject_key } : null;
}
function componentForFile(ctx, repositoryId, filePath) {
    const components = ctx.db
        .all('SELECT * FROM components WHERE repository_id = :repositoryId', { repositoryId })
        .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return components.find((c) => !c.path || normalized.startsWith(`${c.path.replace(/\/+$/, '')}/`));
}
export function findOwner(ctx, identity, resource) {
    const text = resource.trim();
    const found = (componentId, matchedBy, extra = {}) => {
        assertRead(ctx, identity, componentId);
        return { resource: text, matched_by: matchedBy, ...describeOwner(ctx, componentId), ...extra };
    };
    const component = getComponent(ctx, text);
    if (component)
        return found(component.id, 'component');
    const endpoint = endpointOwner(ctx, text);
    if (endpoint)
        return found(endpoint.component, `endpoint ${endpoint.key}`);
    const task = ctx.db.get('SELECT key, component_id FROM tasks WHERE key = :key COLLATE NOCASE', { key: text });
    if (task?.component_id)
        return found(task.component_id, `task ${task.key}`);
    // File paths: "repo:path/to/file" or "path/to/file" searched across repositories.
    const fileMatch = /^(?:([A-Za-z0-9._-]+):)?([^\s:]+\/[^\s]*|[^\s/]+\.[A-Za-z0-9]+)$/.exec(text);
    if (fileMatch && !text.startsWith('/')) {
        const repos = fileMatch[1]
            ? [fileMatch[1]]
            : ctx.db.all('SELECT id FROM repositories ORDER BY id').map((r) => r.id);
        for (const repositoryId of repos) {
            const rule = matchCodeowners(loadCodeowners(ctx, repositoryId), fileMatch[2]);
            const owningComponent = componentForFile(ctx, repositoryId, fileMatch[2]);
            if (rule || (fileMatch[1] && owningComponent)) {
                if (owningComponent) {
                    return found(owningComponent.id, `path in ${repositoryId}`, {
                        file_owners: rule ? resolveOwnerHandles(ctx, rule.owners) : undefined,
                    });
                }
            }
        }
    }
    const team = ctx.db.get('SELECT id, name FROM teams WHERE id = :id COLLATE NOCASE', {
        id: text,
    });
    if (team) {
        return {
            resource: text,
            matched_by: 'team',
            owner_team: team.id,
            team_name: team.name,
            members: teamMembers(ctx, team.id),
            components: componentsOfTeam(ctx, team.id).filter((id) => canRead(ctx, identity, id)),
        };
    }
    // Fuzzy match over component names, aliases, descriptions and endpoint summaries.
    const query = tokens(text);
    const scored = listComponents(ctx)
        .filter((c) => canRead(ctx, identity, c.id))
        .map((c) => {
        const aliases = ctx.db
            .all('SELECT alias FROM component_aliases WHERE component_id = :id', { id: c.id })
            .map((a) => a.alias);
        const endpoints = ctx.db
            .all(`SELECT subject, title FROM context_entries WHERE component_id = :id AND status = 'current' AND type = 'api_contract'`, { id: c.id })
            .map((e) => `${e.subject} ${e.title ?? ''}`);
        const nameScore = matchScore(query, tokens([c.id, ...aliases].join(' ')));
        const docScore = matchScore(query, tokens([c.description ?? '', ...endpoints].join(' ')));
        return { id: c.id, score: Math.max(nameScore, docScore * 0.9) };
    })
        .filter((s) => s.score >= 0.5)
        .sort((a, b) => b.score - a.score);
    if (scored.length) {
        const best = scored[0];
        const others = scored.slice(1).filter((s) => s.score >= best.score - 0.15).map((s) => s.id);
        return found(best.id, `search (score ${best.score.toFixed(2)})`, others.length ? { other_candidates: others } : {});
    }
    return {
        resource: text,
        matched_by: 'none',
        message: `No component, endpoint, task, file or team matches "${text}".`,
        candidates: listComponents(ctx)
            .filter((c) => canRead(ctx, identity, c.id))
            .map((c) => c.id),
    };
}
//# sourceMappingURL=registry.js.map