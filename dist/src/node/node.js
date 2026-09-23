/**
 * A developer's local node: graph memory, keys, encrypted messaging and the approval queue.
 * Agents talk to it over stdio MCP; the optional daemon keeps it connected to the hub in real time.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit } from '../audit.js';
import { composeConfig, loadNodeConfig, validateManifest } from '../config.js';
import { applySettlement, detectConflicts, recordReportedConflict } from '../conflicts.js';
import { getEntry, upsertEntry } from '../context.js';
import { Db } from '../db.js';
import { indexAll } from '../indexers/index.js';
import { storeTasks } from '../indexers/tasks.js';
import { addEdge, canRead, canWrite, componentOwners, developerTeams, getComponent, syncConfig, teamMembers } from '../registry.js';
import { subjectKey } from '../subjects.js';
import { SYSTEM_IDENTITY } from '../types.js';
import { fromJson, iso, toJson, unique } from '../util.js';
import { activeMembers, getMember, refreshDirectory } from './directory.js';
import { EnvelopeError, openEnvelope, sealEnvelope } from './envelope.js';
import { HubClient, HubError } from './hub-client.js';
import { loadIdentity } from './identity.js';
import { AnswerSchema, ChangeNoticeSchema, ConflictReportSchema, EnquirySchema, GraphUpdateSchema, ManifestPayloadSchema, ReceiptSchema, SnapshotSchema, } from './payloads.js';
export const emptyUpdate = () => ({ entries: [], retired: [], reconfirmed: [], tasks: [], repositories: [], settlements: [] });
function sharedEntry(entry, ctx) {
    const facts = ctx.db.all('SELECT subject_key, field, property, location, value, source_kind, evidence FROM facts WHERE entry_id = :id', { id: entry.id });
    const publisher = fromJson(entry.published_by, null);
    return {
        id: entry.id,
        slot: entry.slot,
        subject: entry.subject,
        component_id: entry.component_id,
        type: entry.type,
        title: entry.title,
        data: fromJson(entry.data, null),
        source_kind: entry.source_kind,
        source_ref: entry.source_ref,
        commit: entry.commit_sha,
        generated_at: entry.generated_at,
        verified_against: fromJson(entry.verified_against, []),
        impl_status: entry.impl_status,
        tests: entry.tests,
        agent: publisher?.agent ?? null,
        facts: facts.map((f) => ({
            subject: f.subject_key,
            field: f.field,
            property: f.property,
            value: fromJson(f.value, null),
            location: f.location,
            source: f.source_kind,
            evidence: f.evidence ?? undefined,
        })),
    };
}
export class LocalNode {
    home;
    settings;
    keys;
    ctx;
    hub;
    constructor(home, settings, keys, ctx, hub) {
        this.home = home;
        this.settings = settings;
        this.keys = keys;
        this.ctx = ctx;
        this.hub = hub;
    }
    static async open(options) {
        const home = resolve(options.home);
        const settings = loadNodeConfig(join(home, 'node.yaml'));
        const keys = await loadIdentity(resolve(home, settings.identity), options.passphrase);
        const db = new Db(resolve(home, settings.database));
        const stored = fromJson(db.get("SELECT value FROM node_state WHERE key = 'manifest'")?.value, null);
        const ctx = {
            db,
            config: composeConfig(stored?.manifest ?? null, settings),
            now: options.now ?? (() => new Date()),
            log: options.log ?? ((message) => console.error(`[agent-network] ${message}`)),
        };
        syncConfig(ctx);
        const hub = new HubClient(settings.hub, settings.org, { member: keys.developer, signPrivate: keys.sign.private }, options.fetch);
        return new LocalNode(home, settings, keys, ctx, hub);
    }
    static exists(home) {
        return existsSync(join(resolve(home), 'node.yaml'));
    }
    get developer() {
        return this.keys.developer;
    }
    close() {
        this.ctx.db.close();
    }
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    state(key) {
        return this.ctx.db.get('SELECT value FROM node_state WHERE key = :key', { key })?.value ?? null;
    }
    setState(key, value) {
        this.ctx.db.run('INSERT INTO node_state (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
    }
    manifest() {
        return fromJson(this.state('manifest'), null);
    }
    applyManifest(version, raw) {
        const current = this.manifest();
        if (current && current.version >= version)
            return false;
        const manifest = validateManifest(raw);
        this.setState('manifest', toJson({ version, manifest }));
        this.ctx.config = composeConfig(manifest, this.settings);
        syncConfig(this.ctx);
        this.ctx.log(`manifest v${version} applied (${Object.keys(manifest.components).length} components)`);
        return true;
    }
    // -------------------------------------------------------------------------
    // Identities
    // -------------------------------------------------------------------------
    /** The local developer as seen by the graph engine, acting through a given agent. */
    me(agent = 'agent', component = null, repository = null) {
        const manifest = this.manifest()?.manifest;
        const dev = manifest?.developers[this.developer];
        let resolved = component ? (getComponent(this.ctx, component)?.id ?? null) : null;
        if (!resolved && repository) {
            const inRepo = this.ctx.db.all('SELECT id FROM components WHERE repository_id = :repository', { repository });
            resolved = inRepo.length === 1 ? inRepo[0].id : null;
        }
        return {
            developer: this.developer,
            name: dev?.name ?? this.keys.name,
            teams: developerTeams(this.ctx, this.developer),
            admin: dev?.admin ?? false,
            agent,
            repository,
            component: resolved,
            task: null,
        };
    }
    memberIdentity(memberId, agent = null) {
        const dev = this.manifest()?.manifest.developers[memberId];
        return {
            developer: memberId,
            name: dev?.name ?? getMember(this.ctx, memberId)?.name ?? null,
            teams: developerTeams(this.ctx, memberId),
            admin: dev?.admin ?? false,
            agent: agent ?? 'agent',
            repository: null,
            component: null,
            task: null,
        };
    }
    isRoot(memberId) {
        return memberId === this.keys.root.id;
    }
    // -------------------------------------------------------------------------
    // Directory & audiences
    // -------------------------------------------------------------------------
    async refreshDirectory() {
        return (await refreshDirectory(this.ctx, this.hub, this.keys)).members;
    }
    activeMember(id) {
        const member = getMember(this.ctx, id);
        return member?.status === 'active' ? member : undefined;
    }
    /** Active members allowed to read a component (all members for org-visible components). */
    readers(componentId) {
        return activeMembers(this.ctx).filter((m) => canRead(this.ctx, this.memberIdentity(m.id), componentId));
    }
    /** Who should receive a question about a component: its owners, or the whole owning team when urgent. */
    responders(componentId, priority) {
        const component = getComponent(this.ctx, componentId);
        const ids = unique([...componentOwners(this.ctx, componentId), ...(priority === 'urgent' && component ? teamMembers(this.ctx, component.team_id) : [])]);
        return ids.filter((id) => id !== this.developer).map((id) => this.activeMember(id)).filter((m) => !!m);
    }
    // -------------------------------------------------------------------------
    // Sending
    // -------------------------------------------------------------------------
    async send(message) {
        const recipients = message.to.filter((m) => m.id !== this.developer);
        if (recipients.length === 0)
            throw new Error('No active recipients for this message.');
        const envelope = await sealEnvelope(this.keys, recipients, {
            kind: message.kind,
            priority: message.priority,
            payload: message.payload,
            replyTo: message.replyTo ?? null,
            now: this.ctx.now(),
        });
        const { header } = envelope;
        this.ctx.db.run(`INSERT INTO outbox (id, kind, priority, audience, subject, component_id, payload, envelope, state, created_at, expires_at)
       VALUES (:id, :kind, :priority, :audience, :subject, :component, :payload, :envelope, 'pending', :now, :expires)`, {
            id: header.id,
            kind: header.kind,
            priority: header.priority,
            audience: toJson(header.audience),
            subject: message.subject ?? null,
            component: message.component ?? null,
            payload: toJson(message.payload),
            envelope: toJson(envelope),
            now: header.created_at,
            expires: header.expires_at,
        });
        audit(this.ctx, this.me(), `message.${header.kind}`, { subject: message.subject ?? null, request_id: header.id, details: { priority: header.priority, to: header.audience } });
        try {
            const result = await this.hub.post(envelope);
            this.ctx.db.run("UPDATE outbox SET state = 'sent', sent_at = :now, seq = :seq, online = :online WHERE id = :id", {
                now: iso(this.ctx.now()),
                seq: result.seq,
                online: toJson(result.online),
                id: header.id,
            });
            return { id: header.id, queued: false, online: result.online };
        }
        catch (error) {
            if (error instanceof HubError && (error.status === 0 || error.status >= 500 || error.status === 429)) {
                this.ctx.db.run('UPDATE outbox SET error = :error WHERE id = :id', { error: error.message, id: header.id });
                return { id: header.id, queued: true, online: [] };
            }
            this.ctx.db.run("UPDATE outbox SET state = 'failed', error = :error WHERE id = :id", { error: String(error), id: header.id });
            throw error;
        }
    }
    /** Retries messages that could not be delivered while the hub was unreachable. */
    async flushOutbox() {
        const pending = this.ctx.db.all("SELECT id, envelope, expires_at FROM outbox WHERE state = 'pending' ORDER BY created_at");
        let sent = 0;
        for (const row of pending) {
            if (row.expires_at < iso(this.ctx.now())) {
                this.ctx.db.run("UPDATE outbox SET state = 'expired' WHERE id = :id", { id: row.id });
                continue;
            }
            try {
                const result = await this.hub.post(JSON.parse(row.envelope));
                this.ctx.db.run("UPDATE outbox SET state = 'sent', sent_at = :now, seq = :seq, online = :online, error = NULL WHERE id = :id", {
                    now: iso(this.ctx.now()),
                    seq: result.seq,
                    online: toJson(result.online),
                    id: row.id,
                });
                sent++;
            }
            catch (error) {
                if (error instanceof HubError && error.status === 409) {
                    this.ctx.db.run("UPDATE outbox SET state = 'sent', error = NULL WHERE id = :id", { id: row.id });
                }
                else if (error instanceof HubError && error.status >= 400 && error.status < 500 && error.status !== 429) {
                    this.ctx.db.run("UPDATE outbox SET state = 'failed', error = :error WHERE id = :id", { error: error.message, id: row.id });
                }
                else
                    break;
            }
        }
        return sent;
    }
    // -------------------------------------------------------------------------
    // Receiving
    // -------------------------------------------------------------------------
    /** Pulls everything addressed to this node since the last cursor. */
    async pull() {
        const results = [];
        let cursor = Number(this.state('cursor') ?? 0);
        for (let page = 0; page < 50; page++) {
            const batch = await this.hub.messages(cursor);
            for (const message of batch.messages) {
                const result = await this.processEnvelope(message.envelope);
                if (result)
                    results.push(result);
            }
            cursor = batch.cursor;
            this.setState('cursor', String(cursor));
            if (!batch.more)
                break;
        }
        this.setState('last_pull', iso(this.ctx.now()));
        return results;
    }
    processed(id) {
        return !!this.ctx.db.get('SELECT 1 FROM processed_messages WHERE id = :id', { id });
    }
    async processEnvelope(envelope) {
        const header = envelope?.header;
        if (!header?.id || this.processed(header.id))
            return null;
        let opened;
        try {
            opened = await openEnvelope(this.keys, envelope, (id) => this.activeMember(id), this.ctx.now());
        }
        catch (error) {
            if (error instanceof EnvelopeError && /unknown or unverified sender/.test(error.message)) {
                await this.refreshDirectory();
                try {
                    opened = await openEnvelope(this.keys, envelope, (id) => this.activeMember(id), this.ctx.now());
                }
                catch (retry) {
                    return this.reject(header, retry);
                }
            }
            else {
                return this.reject(header, error);
            }
        }
        try {
            return this.ctx.db.tx(() => {
                if (this.processed(header.id))
                    return null;
                const extra = this.handle(opened.header, opened.payload, opened.sender);
                this.ctx.db.run("INSERT INTO processed_messages (id, seq, kind, sender, status, at) VALUES (:id, NULL, :kind, :sender, 'ok', :now)", { id: header.id, kind: header.kind, sender: header.sender, now: iso(this.ctx.now()) });
                return { id: header.id, kind: header.kind, priority: header.priority, sender: header.sender, status: 'ok', ...extra };
            });
        }
        catch (error) {
            return this.reject(header, error);
        }
    }
    reject(header, error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.db.run(`INSERT OR IGNORE INTO processed_messages (id, seq, kind, sender, status, error, at) VALUES (:id, NULL, :kind, :sender, 'rejected', :error, :now)`, { id: header.id, kind: header.kind ?? null, sender: header.sender ?? null, error: message, now: iso(this.ctx.now()) });
        audit(this.ctx, null, 'message.rejected', { request_id: header.id, details: { sender: header.sender, kind: header.kind, error: message } });
        this.ctx.log(`rejected message ${header.id} from ${header.sender}: ${message}`);
        return { id: header.id, kind: header.kind, priority: header.priority, sender: header.sender, status: 'rejected' };
    }
    inboxInsert(header, fields) {
        this.ctx.db.run(`INSERT OR IGNORE INTO inbox (id, kind, priority, sender, subject, component_id, payload, state, reply_to, created_at, received_at, expires_at)
       VALUES (:id, :kind, :priority, :sender, :subject, :component, :payload, :state, :replyTo, :created, :now, :expires)`, {
            id: header.id,
            kind: fields.kind ?? header.kind,
            priority: header.priority,
            sender: header.sender,
            subject: fields.subject ?? null,
            component: fields.component ?? null,
            payload: toJson(fields.payload),
            state: fields.state,
            replyTo: header.reply_to,
            created: header.created_at,
            now: iso(this.ctx.now()),
            expires: header.expires_at,
        });
    }
    appendReply(header, payload) {
        if (!header.reply_to)
            return;
        const row = this.ctx.db.get('SELECT replies FROM outbox WHERE id = :id', { id: header.reply_to });
        if (!row)
            return;
        const replies = fromJson(row.replies, []);
        replies.push({ id: header.id, kind: header.kind, from: header.sender, at: header.created_at, payload });
        const state = header.kind === 'answer' ? (payload.status === 'escalated' ? 'escalated' : 'answered') : undefined;
        this.ctx.db.run(`UPDATE outbox SET replies = :replies${state ? ', state = :state' : ''} WHERE id = :id`, {
            replies: toJson(replies),
            ...(state ? { state } : {}),
            id: header.reply_to,
        });
    }
    handle(header, raw, sender) {
        const from = this.memberIdentity(sender.id);
        switch (header.kind) {
            case 'manifest': {
                if (!this.isRoot(sender.id))
                    throw new Error('manifest not signed by the org root');
                const { version, manifest } = ManifestPayloadSchema.parse(raw);
                this.applyManifest(version, manifest);
                return {};
            }
            case 'snapshot': {
                if (!this.isRoot(sender.id))
                    throw new Error('snapshot not signed by the org root');
                const snapshot = SnapshotSchema.parse(raw);
                this.applyGraphUpdate(snapshot.graph, sender, { force: true });
                return {};
            }
            case 'graph_update': {
                this.applyGraphUpdate(GraphUpdateSchema.parse(raw), sender, { force: false, messageHeader: header });
                return {};
            }
            case 'enquiry': {
                const enquiry = EnquirySchema.parse(raw);
                this.inboxInsert(header, { state: 'open', subject: enquiry.subject, component: enquiry.component, payload: enquiry });
                return { urgentEnquiry: header.priority === 'urgent' && canWrite(this.ctx, this.me(), enquiry.component) };
            }
            case 'answer': {
                const answer = AnswerSchema.parse(raw);
                this.appendReply(header, answer);
                this.inboxInsert(header, { state: 'unread', payload: answer });
                return {};
            }
            case 'conflict_report': {
                const report = ConflictReportSchema.parse(raw);
                recordReportedConflict(this.ctx, header.id, { ...from, agent: report.agent }, report);
                this.inboxInsert(header, { state: 'open', subject: report.subject, component: report.component, payload: report });
                return {};
            }
            case 'change_notice':
            case 'implementation_doc': {
                const notice = ChangeNoticeSchema.parse(raw);
                this.inboxInsert(header, { state: 'pending_approval', subject: notice.subject, component: notice.component, payload: notice });
                return {};
            }
            case 'receipt': {
                const receipt = ReceiptSchema.parse(raw);
                this.appendReply({ ...header, reply_to: header.reply_to ?? receipt.item }, receipt);
                this.inboxInsert(header, { state: 'unread', payload: receipt });
                return {};
            }
        }
    }
    // -------------------------------------------------------------------------
    // Shared graph memory
    // -------------------------------------------------------------------------
    /**
     * Applies knowledge from another member. Under the default policy, knowledge about a component from its owning team
     * is applied immediately; anything else is held in the approval queue for the developer.
     */
    applyGraphUpdate(update, sender, options) {
        const from = this.memberIdentity(sender.id);
        const policy = this.settings.policy.apply_updates;
        const trusted = (component) => options.force || policy === 'all' || (policy === 'owner_authoritative' && component !== null && canWrite(this.ctx, from, component));
        const visible = (component) => canRead(this.ctx, this.me(), component);
        const now = emptyUpdate();
        const later = emptyUpdate();
        for (const entry of update.entries)
            if (visible(entry.component_id))
                (trusted(entry.component_id) ? now : later).entries.push(entry);
        for (const retired of update.retired)
            (trusted(retired.component_id) ? now : later).retired.push(retired);
        for (const reconfirmed of update.reconfirmed)
            now.reconfirmed.push(reconfirmed);
        for (const task of update.tasks)
            if (visible(task.component_id))
                (trusted(task.component_id) ? now : later).tasks.push(task);
        now.repositories.push(...update.repositories);
        for (const settlement of update.settlements)
            (trusted(settlement.component) ? now : later).settlements.push(settlement);
        const applied = this.applyUpdateNow(now, sender);
        const queued = later.entries.length + later.retired.length + later.tasks.length + later.settlements.length;
        if (queued > 0 && options.messageHeader) {
            this.inboxInsert(options.messageHeader, {
                state: 'pending_approval',
                subject: later.entries[0]?.subject ?? later.tasks[0]?.key ?? later.settlements[0]?.subject ?? null,
                component: later.entries[0]?.component_id ?? later.tasks[0]?.component_id ?? later.settlements[0]?.component ?? null,
                payload: { update: later, summary: `${queued} memory update(s) from ${sender.id} about components they don't own` },
            });
        }
        return { applied, queued };
    }
    applyUpdateNow(update, sender) {
        const from = this.memberIdentity(sender.id);
        let applied = 0;
        this.ctx.db.tx(() => {
            const factSubjects = [];
            for (const entry of update.entries) {
                const result = upsertEntry(this.ctx, {
                    id: entry.id,
                    slot: entry.slot,
                    subject: entry.subject,
                    component_id: entry.component_id,
                    type: entry.type,
                    title: entry.title,
                    data: entry.data,
                    source_kind: entry.source_kind,
                    source_ref: entry.source_ref,
                    commit: entry.commit,
                    generated_at: entry.generated_at,
                    published_by: { ...from, agent: entry.agent ?? 'agent' },
                    verified_against: entry.verified_against,
                    impl_status: entry.impl_status,
                    tests: entry.tests,
                    facts: entry.facts,
                    origin: sender.id,
                });
                if (result.changed)
                    applied++;
                factSubjects.push(...result.factSubjects);
                if (entry.type === 'dependency' && entry.component_id) {
                    for (const dependency of entry.data?.depends_on ?? []) {
                        const target = getComponent(this.ctx, dependency);
                        addEdge(this.ctx, 'component', entry.component_id, 'consumes', target ? 'component' : 'subject', target ? target.id : subjectKey(dependency), `member:${sender.id}`);
                    }
                }
            }
            for (const retired of update.retired) {
                const existing = getEntry(this.ctx, retired.id);
                if (!existing || existing.origin !== sender.id || existing.status === 'retired')
                    continue;
                this.ctx.db.run("UPDATE context_entries SET status = 'retired' WHERE id = :id", { id: retired.id });
                factSubjects.push(...this.ctx.db.all('SELECT DISTINCT subject_key FROM facts WHERE entry_id = :id', { id: retired.id }).map((r) => r.subject_key));
                applied++;
            }
            for (const r of update.reconfirmed) {
                this.ctx.db.run('UPDATE context_entries SET commit_sha = :commit, generated_at = :at WHERE id = :id AND origin = :origin AND generated_at < :at', {
                    commit: r.commit,
                    at: r.generated_at,
                    id: r.id,
                    origin: sender.id,
                });
            }
            if (update.tasks.length)
                storeTasks(this.ctx, update.tasks, { origin: sender.id });
            for (const repo of update.repositories) {
                const local = this.settings.repositories[repo.id];
                if (local)
                    continue;
                this.ctx.db.run(`INSERT INTO repositories (id, location, head_commit, indexed_at) VALUES (:id, :location, :head, :at)
           ON CONFLICT(id) DO UPDATE SET head_commit = excluded.head_commit, indexed_at = excluded.indexed_at
           WHERE repositories.location LIKE 'remote:%'`, { id: repo.id, location: `remote:${sender.id}`, head: repo.head_commit, at: repo.indexed_at });
            }
            for (const settlement of update.settlements) {
                applySettlement(this.ctx, settlement, from);
                applied++;
            }
            if (factSubjects.length)
                detectConflicts(this.ctx, unique(factSubjects), { ...SYSTEM_IDENTITY, agent: 'sync' });
        });
        if (applied)
            audit(this.ctx, from, 'memory.applied', { details: { entries: update.entries.length, tasks: update.tasks.length, settlements: update.settlements.length } });
        return applied;
    }
    /** Local knowledge not yet shared, grouped by who may read it. */
    pendingUpdates() {
        const groups = new Map();
        const groupFor = (component) => {
            const to = this.readers(component).filter((m) => m.id !== this.developer);
            const key = to.map((m) => m.id).join(',');
            if (!groups.has(key))
                groups.set(key, { to, update: emptyUpdate() });
            return groups.get(key).update;
        };
        const entries = this.ctx.db.all("SELECT * FROM context_entries WHERE origin = 'local' AND shared IN (0, 2)");
        for (const entry of entries) {
            if (entry.type === 'task')
                continue;
            if (entry.shared === 2)
                groupFor(entry.component_id).reconfirmed.push({ id: entry.id, commit: entry.commit_sha, generated_at: entry.generated_at });
            else if (entry.status === 'current')
                groupFor(entry.component_id).entries.push(sharedEntry(entry, this.ctx));
            else if (entry.status === 'retired')
                groupFor(entry.component_id).retired.push({ id: entry.id, component_id: entry.component_id });
        }
        const tasks = this.ctx.db.all("SELECT * FROM tasks WHERE origin = 'local' AND shared = 0");
        for (const task of tasks) {
            groupFor(task.component_id).tasks.push({
                key: task.key,
                source: task.source,
                title: task.title,
                description: task.description,
                status: task.status,
                url: task.url,
                component_id: task.component_id,
                assignee: task.assignee,
                labels: fromJson(task.labels, []),
                updated_at: task.updated_at,
            });
        }
        const sharedHeads = fromJson(this.state('shared_heads'), {});
        for (const repo of this.ctx.db.all("SELECT id, head_commit, indexed_at FROM repositories WHERE location NOT LIKE 'remote:%' AND indexed_at IS NOT NULL")) {
            if (sharedHeads[repo.id] === repo.head_commit)
                continue;
            const components = this.ctx.db.all('SELECT id FROM components WHERE repository_id = :id', { id: repo.id });
            groupFor(components.length === 1 ? components[0].id : null).repositories.push(repo);
        }
        return groups;
    }
    /** Shares new local knowledge with everyone allowed to read it (low priority, end-to-end encrypted). */
    async publishPending() {
        const sent = [];
        for (const { to, update } of this.pendingUpdates().values()) {
            const size = update.entries.length + update.retired.length + update.reconfirmed.length + update.tasks.length + update.repositories.length;
            if (size === 0)
                continue;
            if (to.length > 0) {
                for (const chunk of chunkUpdate(update)) {
                    const result = await this.send({ kind: 'graph_update', priority: 'low', to, payload: chunk });
                    sent.push(result.id);
                }
            }
            this.ctx.db.tx(() => {
                for (const e of [...update.entries, ...update.retired, ...update.reconfirmed])
                    this.ctx.db.run('UPDATE context_entries SET shared = 1 WHERE id = :id', { id: e.id });
                for (const t of update.tasks)
                    this.ctx.db.run('UPDATE tasks SET shared = 1 WHERE key = :key', { key: t.key });
                const heads = fromJson(this.state('shared_heads'), {});
                for (const r of update.repositories)
                    heads[r.id] = r.head_commit;
                this.setState('shared_heads', toJson(heads));
            });
        }
        // Local task entries are derived on every node from the shared task itself.
        this.ctx.db.run("UPDATE context_entries SET shared = 1 WHERE origin = 'local' AND type = 'task' AND shared != 1");
        return sent;
    }
    /** Current graph state readable by a given member, for onboarding a new member. */
    exportGraph(forMember) {
        const reader = this.memberIdentity(forMember);
        const update = emptyUpdate();
        for (const entry of this.ctx.db.all("SELECT * FROM context_entries WHERE status = 'current' AND type != 'task'")) {
            if (canRead(this.ctx, reader, entry.component_id))
                update.entries.push(sharedEntry(entry, this.ctx));
        }
        for (const task of this.ctx.db.all('SELECT * FROM tasks')) {
            if (!canRead(this.ctx, reader, task.component_id))
                continue;
            update.tasks.push({ ...task, labels: fromJson(task.labels, []) });
        }
        for (const conflict of this.ctx.db.all("SELECT * FROM conflicts WHERE state = 'resolved' AND resolution IS NOT NULL")) {
            if (!canRead(this.ctx, reader, conflict.component_id))
                continue;
            update.settlements.push({
                fingerprint: conflict.fingerprint,
                conflict_ref: conflict.origin === 'reported' ? conflict.id : (conflict.fingerprint ?? conflict.id),
                component: conflict.component_id,
                subject: conflict.subject,
                field: conflict.field,
                property: conflict.property,
                location: conflict.location,
                resolution: conflict.resolution,
                correct_value: fromJson(conflict.resolved_value, undefined),
                follow_up: fromJson(conflict.follow_up, []),
                decided_by: /dashboard|human/.test(conflict.resolved_by ?? '') ? 'human' : 'agent',
            });
        }
        return update;
    }
    // -------------------------------------------------------------------------
    // Indexing
    // -------------------------------------------------------------------------
    async index() {
        return indexAll(this.ctx);
    }
    presence(online) {
        const now = iso(this.ctx.now());
        this.ctx.db.tx(() => {
            this.ctx.db.run("DELETE FROM presence WHERE agent = 'node'");
            for (const developer of online) {
                this.ctx.db.run("INSERT OR REPLACE INTO presence (developer_id, agent, repository, last_seen) VALUES (:developer, 'node', '', :now)", { developer, now });
            }
        });
    }
    daemonAlive() {
        const beat = this.state('daemon_heartbeat');
        return !!beat && this.ctx.now().getTime() - Date.parse(beat) < 30_000;
    }
}
/** Splits a large update so each envelope stays well under the hub's size limit. */
export function chunkUpdate(update, maxBytes = 300_000) {
    const chunks = [];
    let current = emptyUpdate();
    let size = 0;
    const push = (key, item) => {
        const itemSize = JSON.stringify(item).length;
        if (size + itemSize > maxBytes && size > 0) {
            chunks.push(current);
            current = emptyUpdate();
            size = 0;
        }
        current[key].push(item);
        size += itemSize;
    };
    for (const key of ['repositories', 'tasks', 'entries', 'retired', 'reconfirmed', 'settlements']) {
        for (const item of update[key])
            push(key, item);
    }
    if (size > 0 || chunks.length === 0)
        chunks.push(current);
    return chunks;
}
//# sourceMappingURL=node.js.map