import { audit, describeActor } from '../audit.js';
import { escalateConflict, getConflict, presentConflict, resolveConflict } from '../conflicts.js';
import { getContext, publishContext, recordAnswer, resolveSubject, upsertEntry } from '../context.js';
import { consumersOf, getDependencies } from '../dependencies.js';
import { conflict as conflictError, forbidden, invalid, notFound } from '../errors.js';
import { assertRead, assertWrite, canRead, canWrite, componentOwners, componentsOfTeam, developerTeams, endpointOwner, findOwner, getComponent, listComponents, teamMembers } from '../registry.js';
import { activeProjects, currentProject, scopeRules } from '../scope.js';
import { subjectKey } from '../subjects.js';
import { ageLabel, fromJson, iso, toJson, unique } from '../util.js';
import { HubError } from './hub-client.js';
import { emptyUpdate } from './node.js';
const PRIORITY_RANK = { urgent: 0, normal: 1, low: 2 };
export class AgentSession {
    node;
    agent;
    component;
    repository;
    /** Directory the agent was started in; used to tell which project it is working on. */
    cwd;
    lastSync = 0;
    offline = null;
    constructor(node, options = {}) {
        this.node = node;
        this.agent = options.agent ?? 'agent';
        this.component = options.component ?? null;
        this.repository = options.repository ?? null;
        this.cwd = options.cwd ?? null;
    }
    get ctx() {
        return this.node.ctx;
    }
    get identity() {
        return this.node.me(this.agent, this.component, this.repository);
    }
    // -------------------------------------------------------------------------
    // Sync (skipped when the daemon is running; it keeps the node current in real time)
    // -------------------------------------------------------------------------
    async sync(force = false) {
        const due = Date.now() - this.lastSync > this.node.settings.sync.poll_seconds * 1000;
        if (!force && (this.node.daemonAlive() || !due))
            return;
        this.lastSync = Date.now();
        try {
            if (!this.ctx.db.get("SELECT 1 FROM members LIMIT 1"))
                await this.node.refreshDirectory();
            await this.node.flushOutbox();
            await this.node.pull();
            await this.node.publishPending();
            this.offline = null;
        }
        catch (error) {
            this.offline = error instanceof HubError ? error.message : String(error);
        }
    }
    async share() {
        try {
            await this.node.publishPending();
            await this.node.flushOutbox();
        }
        catch (error) {
            this.offline = error instanceof Error ? error.message : String(error);
        }
    }
    async shareSettlement(settlement) {
        const to = this.node.readers(settlement.component).filter((m) => m.id !== this.node.developer);
        if (to.length === 0)
            return;
        const update = emptyUpdate();
        update.settlements.push(settlement);
        await this.node.send({ kind: 'graph_update', priority: 'low', to, payload: update, subject: settlement.subject, component: settlement.component });
    }
    // -------------------------------------------------------------------------
    // Reads: local graph memory
    // -------------------------------------------------------------------------
    /**
     * The project map: where to work, what each project is, and which shared components live there. Calling this first
     * replaces exploring the machine to find out.
     */
    orient() {
        const settings = this.node.settings;
        const projects = activeProjects(settings);
        const here = this.cwd ? currentProject(settings, this.cwd) : null;
        const identity = this.identity;
        const components = listComponents(this.ctx).filter((c) => canRead(this.ctx, identity, c.id));
        const roots = projects.flatMap((p) => p.paths);
        return {
            workspace: settings.workspace ? { name: settings.workspace, description: settings.workspaces[settings.workspace]?.description ?? '' } : null,
            you_are_in: here?.name ?? null,
            projects: projects.map((p) => ({
                name: p.name,
                description: p.description || null,
                paths: p.paths,
                notes: p.notes,
                repository: p.repository,
                components: components
                    .filter((c) => p.repository && c.repository_id === p.repository)
                    .map((c) => ({ id: c.id, description: c.description, team: c.team_id, owners: componentOwners(this.ctx, c.id) })),
            })),
            other_components: components.filter((c) => !projects.some((p) => p.repository && c.repository_id === p.repository)).map((c) => ({ id: c.id, description: c.description, team: c.team_id })),
            /** Experiment orgs: members who can read every message. Empty in a normal org. */
            observed_by: this.node.observers(),
            rules: scopeRules(roots),
            next: projects.length ? ['get_inbox', 'get_context <component or endpoint> before building against it', 'find_owner <thing> when you need a person'] : ['Ask your developer to run: agent-network setup'],
        };
    }
    async findOwner(resource) {
        await this.sync();
        return findOwner(this.ctx, this.identity, resource);
    }
    async getContext(subject) {
        await this.sync();
        return { ...getContext(this.ctx, this.identity, { subject }), memory: this.memoryStatus() };
    }
    async getDependencies(input) {
        await this.sync();
        return getDependencies(this.ctx, this.identity, input);
    }
    memoryStatus() {
        return {
            source: 'local graph memory',
            last_sync: this.node.state('last_pull'),
            realtime: this.node.daemonAlive(),
            ...(this.offline ? { hub: `unreachable (${this.offline}); answers come from the last synced state` } : {}),
        };
    }
    // -------------------------------------------------------------------------
    // publish_context
    // -------------------------------------------------------------------------
    async publishContext(input) {
        const identity = this.identity;
        const result = publishContext(this.ctx, identity, input);
        if (input.depends_on?.length) {
            const dependencies = this.ctx.db
                .all("SELECT DISTINCT to_id FROM edges WHERE from_kind = 'component' AND from_id = :id AND rel = 'consumes' AND source = 'agent'", { id: result.component })
                .map((r) => r.to_id);
            upsertEntry(this.ctx, {
                subject: result.component,
                component_id: result.component,
                type: 'dependency',
                data: { depends_on: dependencies },
                source_kind: 'agent',
                published_by: identity,
                slot: `dependency|agent|${result.component}`,
            });
        }
        let notices = [];
        const change = result.contract_change;
        if (change && change.changes.some((c) => c.severity !== 'non_breaking')) {
            notices = await this.notifyConsumers(result.subject, change.key, result.component, change.changes);
        }
        await this.share();
        return { ...result, shared_with: 'every member allowed to read this component (end-to-end encrypted)', change_notices: notices };
    }
    /** Breaking or risky contract changes ask each consuming team's developer to approve adapting to them. */
    async notifyConsumers(subject, key, component, changes) {
        const consumers = consumersOf(this.ctx, key, component);
        const sent = [];
        for (const consumer of consumers) {
            const to = this.ownersOf(consumer);
            if (to.length === 0)
                continue;
            const significant = changes.filter((c) => c.severity !== 'non_breaking');
            const payload = {
                subject,
                component,
                title: `Contract change in ${subject}`,
                summary: `${component} changed ${subject}. ${significant.length} change(s) may affect ${consumer}.`,
                doc: null,
                changes: significant,
                action_required: true,
                breaking: significant.some((c) => c.severity === 'breaking'),
                entries: [],
                agent: this.agent,
            };
            const result = await this.node.send({ kind: 'change_notice', priority: 'low', to, payload, subject, component: consumer });
            sent.push({ component: consumer, message_id: result.id });
        }
        return sent;
    }
    ownersOf(componentId) {
        return componentOwners(this.ctx, componentId)
            .filter((id) => id !== this.node.developer)
            .map((id) => this.node.activeMember(id))
            .filter((m) => !!m);
    }
    // -------------------------------------------------------------------------
    // ask (enquiry with priority)
    // -------------------------------------------------------------------------
    resolveTarget(owner, subject) {
        if (owner) {
            const component = getComponent(this.ctx, owner);
            if (component)
                return { component: component.id, developer: null };
            const developer = this.ctx.db.get('SELECT id FROM developers WHERE id = :id COLLATE NOCASE', { id: owner });
            if (developer) {
                // An enquiry is always about a component: it is how the receiver finds the repository and how access is checked.
                // `orient` lists owners by developer id, so agents often ask a person; resolve the component they stand for.
                const owned = this.ctx.db.all('SELECT DISTINCT component_id FROM component_owners WHERE developer_id = :id', { id: developer.id }).map((r) => r.component_id);
                const candidates = owned.length ? owned : developerTeams(this.ctx, developer.id).flatMap((team) => componentsOfTeam(this.ctx, team));
                const named = subject ? (endpointOwner(this.ctx, subject)?.component ?? getComponent(this.ctx, subject)?.id ?? null) : null;
                const component = candidates.length === 1 ? candidates[0] : named && candidates.includes(named) ? named : null;
                if (!component) {
                    throw invalid(candidates.length
                        ? `${developer.id} is responsible for several components (${candidates.join(', ')}); pass the one you mean as "owner".`
                        : `${developer.id} does not own a component, so there is nothing to ask them about. Use find_owner.`);
                }
                return { component, developer: developer.id };
            }
            const team = this.ctx.db.get('SELECT id FROM teams WHERE id = :id COLLATE NOCASE', { id: owner });
            if (team) {
                const components = componentsOfTeam(this.ctx, team.id);
                if (components.length === 1)
                    return { component: components[0], developer: null };
                throw invalid(`Team ${team.id} owns several components (${components.join(', ')}); name the one you mean.`);
            }
            throw notFound(`No component, developer or team named "${owner}". Use find_owner.`);
        }
        if (subject) {
            const found = endpointOwner(this.ctx, subject)?.component ?? getComponent(this.ctx, subject)?.id ?? resolveSubject(this.ctx, this.identity, subject).best?.component_id;
            if (found)
                return { component: found, developer: null };
        }
        throw invalid('Could not determine who to ask. Pass "owner" (component, team or developer); find_owner can look it up.');
    }
    async ask(input) {
        if (!input.question.trim())
            throw invalid('question must not be empty');
        await this.sync();
        const priority = input.priority ?? 'normal';
        const target = this.resolveTarget(input.owner, input.subject);
        assertRead(this.ctx, this.identity, target.component);
        const to = target.developer
            ? [this.node.activeMember(target.developer)].filter((m) => !!m)
            : this.node.responders(target.component, priority);
        if (to.length === 0) {
            throw invalid(`Nobody who owns ${target.component ?? target.developer} has joined the network yet, so there is no one to ask.`);
        }
        const payload = {
            question: input.question,
            subject: input.subject ?? null,
            component: target.component,
            details: input.details ?? null,
            agent: this.agent,
            requester_component: this.identity.component,
            requester_repository: this.repository,
        };
        const sent = await this.node.send({ kind: 'enquiry', priority, to, payload, subject: input.subject ?? null, component: target.component });
        const result = {
            message_id: sent.id,
            priority,
            sent_to: to.map((m) => m.id),
            online_now: sent.online,
            delivery: sent.queued
                ? 'The hub is unreachable; the question is stored locally and will be sent automatically.'
                : sent.online.length
                    ? `Delivered in real time to ${sent.online.join(', ')}.`
                    : 'Nobody who can answer is online; the question is queued and will be delivered when their node connects.',
        };
        const wait = Math.min(Math.max(input.wait_seconds ?? this.node.settings.ask.default_wait_seconds, 0), 120);
        if (wait > 0 && !sent.queued) {
            const answer = await this.waitForReply(sent.id, wait);
            if (answer)
                result.answer = answer;
            else
                result.status = `No answer yet after ${wait}s. Do not guess the answer or build on an assumption about it. If you cannot continue without it, call get_inbox again shortly (the answer arrives there) or tell your developer what you are waiting for.`;
        }
        return result;
    }
    async waitForReply(messageId, seconds) {
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline) {
            if (!this.node.daemonAlive())
                await this.node.pull().catch(() => undefined);
            const row = this.ctx.db.get('SELECT * FROM outbox WHERE id = :id', { id: messageId });
            const reply = fromJson(row?.replies, []).find((r) => r.kind === 'answer');
            if (reply) {
                this.ctx.db.run("UPDATE inbox SET state = 'read' WHERE id = :id", { id: reply.id });
                return { from: reply.from, ...reply.payload };
            }
            await new Promise((done) => setTimeout(done, 1000));
        }
        return null;
    }
    // -------------------------------------------------------------------------
    // announce_change: change notices and implementation docs (queued for the recipients' approval)
    // -------------------------------------------------------------------------
    async announceChange(input) {
        const identity = this.identity;
        const component = (input.component ? getComponent(this.ctx, input.component)?.id : undefined) ??
            endpointOwner(this.ctx, input.subject)?.component ??
            getComponent(this.ctx, input.subject)?.id ??
            identity.component;
        if (!component)
            throw invalid('Cannot tell which component changed. Pass "component".');
        assertWrite(this.ctx, identity, component, 'announce changes');
        const targets = input.to?.length ? input.to : consumersOf(this.ctx, subjectKey(input.subject), component);
        const recipients = new Map();
        for (const target of targets) {
            const asComponent = getComponent(this.ctx, target);
            const asTeam = !asComponent ? this.ctx.db.get('SELECT id FROM teams WHERE id = :id COLLATE NOCASE', { id: target }) : undefined;
            const ids = asComponent ? componentOwners(this.ctx, asComponent.id) : asTeam ? teamMembers(this.ctx, asTeam.id) : [target];
            for (const id of ids) {
                const member = id === this.node.developer ? undefined : this.node.activeMember(id);
                if (member)
                    recipients.set(member.id, { member, component: asComponent?.id ?? null });
            }
        }
        if (recipients.size === 0) {
            throw invalid('No consumers are known for this change and no active recipients were given. Pass "to" (components, teams or developers).');
        }
        const kind = input.kind ?? 'change_notice';
        const docEntry = input.doc
            ? upsertEntry(this.ctx, {
                subject: input.subject,
                component_id: component,
                type: kind === 'implementation_doc' ? 'implementation_doc' : 'behavior',
                title: input.title,
                data: { summary: input.summary, doc: input.doc },
                source_kind: 'agent',
                published_by: identity,
            }).entry
            : null;
        const sent = [];
        const byComponent = new Map();
        for (const { member, component: c } of recipients.values())
            byComponent.set(c ?? '', [...(byComponent.get(c ?? '') ?? []), member]);
        for (const [consumer, members] of byComponent) {
            const payload = {
                subject: input.subject,
                component,
                title: input.title,
                summary: input.summary,
                doc: input.doc ?? null,
                changes: [],
                action_required: input.action_required ?? kind === 'change_notice',
                breaking: false,
                entries: [],
                agent: this.agent,
            };
            const result = await this.node.send({ kind, priority: 'low', to: members, payload, subject: input.subject, component: consumer || null });
            sent.push({ to: members.map((m) => m.id).join(', '), message_id: result.id });
        }
        await this.share();
        return {
            kind,
            component,
            sent,
            documented_in_memory: docEntry?.id ?? null,
            next: "Recipients' developers approve, reject or defer this; you'll receive their receipts in get_inbox.",
        };
    }
    // -------------------------------------------------------------------------
    // Conflicts
    // -------------------------------------------------------------------------
    async reportConflict(input) {
        if (input.sources.length < 2)
            throw invalid('A conflict needs at least two sources that disagree.');
        const target = this.resolveTarget(input.owner, input.subject);
        if (!target.component)
            throw invalid('Report conflicts against a component (pass "owner").');
        assertRead(this.ctx, this.identity, target.component);
        const to = this.node.responders(target.component, 'normal');
        if (to.length === 0)
            throw invalid(`Nobody who owns ${target.component} has joined the network yet.`);
        const description = input.description ??
            `${input.field ? `\`${input.field}\` ` : ''}${input.property ?? 'value'}: ${input.sources.map((s) => `${JSON.stringify(s.value)} according to ${s.source}${s.ref ? ` (${s.ref})` : ''}`).join('; ')}`;
        const sent = await this.node.send({
            kind: 'conflict_report',
            priority: 'normal',
            to,
            subject: input.subject,
            component: target.component,
            payload: { ...input, description, component: target.component, agent: this.agent },
        });
        return { message_id: sent.id, routed_to: to.map((m) => m.id), online_now: sent.online, next: 'The owning agent settles it with evidence or escalates to its developer; the outcome arrives in get_inbox.' };
    }
    async resolveConflict(input, human = false) {
        const conflict = getConflict(this.ctx, input.conflict_id);
        const { settlement } = resolveConflict(this.ctx, this.identity, input, human);
        await this.shareSettlement(settlement);
        if (conflict.origin === 'reported') {
            const reporter = fromJson(conflict.reported_by, null);
            const member = reporter ? this.node.activeMember(reporter.developer) : undefined;
            if (member) {
                await this.reply(conflict.id, member, { status: 'answered', answer: input.resolution, evidence: [...(input.outdated_sources ?? []).map((s) => `outdated: ${s}`), ...(input.follow_up ?? []).map((s) => `follow-up: ${s}`)], confidence: 'high', decided_by_human: human });
            }
            this.ctx.db.run("UPDATE inbox SET state = 'resolved', handled_at = :now WHERE id = :id", { now: iso(this.ctx.now()), id: conflict.id });
        }
        await this.share();
        return { conflict: presentConflict(this.ctx, getConflict(this.ctx, conflict.id)), shared: 'settlement sent to every member who can see this component' };
    }
    async reply(replyTo, to, answer) {
        const payload = { agent: this.agent, auto: null, ...answer };
        return this.node.send({ kind: 'answer', priority: 'normal', to: [to], payload, replyTo });
    }
    // -------------------------------------------------------------------------
    // Inbox
    // -------------------------------------------------------------------------
    presentInbox(row) {
        const payload = fromJson(row.payload, {});
        const sender = this.node.memberIdentity(row.sender);
        return {
            id: row.id,
            kind: row.kind,
            priority: row.priority,
            state: row.state,
            from: row.sender === this.node.developer ? 'you' : `${sender.teams[0] ?? 'org'}/${payload.requester_component ?? row.sender} (${payload.agent ?? 'agent'}, ${row.sender})`,
            subject: row.subject,
            component: row.component_id,
            received: `${row.received_at} (${ageLabel(row.received_at, this.ctx.now())})`,
            ...payload,
            ...(row.decision ? { decision: row.decision } : {}),
            ...(row.note ? { note: fromJson(row.note, row.note) } : {}),
        };
    }
    async inbox() {
        await this.sync();
        const identity = this.identity;
        const rows = this.ctx.db.all('SELECT * FROM inbox ORDER BY received_at');
        const byPriority = (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.received_at.localeCompare(b.received_at);
        const open = rows.filter((r) => r.state === 'open').sort(byPriority);
        const unread = rows.filter((r) => r.state === 'unread');
        const localConflicts = this.ctx.db
            .all("SELECT * FROM conflicts WHERE state = 'open' AND origin = 'detected' ORDER BY created_at")
            .filter((c) => canWrite(this.ctx, identity, c.component_id));
        const waiting = this.ctx.db.all("SELECT * FROM outbox WHERE kind IN ('enquiry', 'conflict_report', 'change_notice', 'implementation_doc') AND state IN ('pending', 'sent', 'escalated') ORDER BY created_at");
        const result = {
            you: { developer: identity.developer, teams: identity.teams, agent: identity.agent, component: identity.component },
            memory: this.memoryStatus(),
            urgent_enquiries: open.filter((r) => r.kind === 'enquiry' && r.priority === 'urgent').map((r) => this.presentInbox(r)),
            enquiries: open.filter((r) => r.kind === 'enquiry' && r.priority !== 'urgent').map((r) => this.presentInbox(r)),
            conflict_reports: open.filter((r) => r.kind === 'conflict_report').map((r) => this.presentInbox(r)),
            local_conflicts: localConflicts.map((c) => presentConflict(this.ctx, c)),
            answers: unread.filter((r) => r.kind === 'answer').map((r) => ({ ...this.presentInbox(r), question: this.questionFor(r.reply_to) })),
            receipts: unread.filter((r) => r.kind === 'receipt').map((r) => this.presentInbox(r)),
            awaiting_your_developer: rows.filter((r) => r.state === 'pending_approval' || r.state === 'escalated').sort(byPriority).map((r) => this.presentInbox(r)),
            approved_actions: rows.filter((r) => r.state === 'approved' && r.kind !== 'graph_update').map((r) => this.presentInbox(r)),
            waiting_on_others: waiting.map((w) => ({
                id: w.id,
                kind: w.kind,
                priority: w.priority,
                state: w.state,
                to: fromJson(w.audience, []),
                subject: w.subject,
                sent: ageLabel(w.created_at, this.ctx.now()),
                ...(w.error ? { delivery_error: w.error } : {}),
                receipts: fromJson(w.replies, []).filter((r) => r.kind === 'receipt'),
            })),
        };
        if (unread.length)
            this.ctx.db.run("UPDATE inbox SET state = 'read' WHERE state = 'unread'");
        return result;
    }
    questionFor(outboxId) {
        if (!outboxId)
            return null;
        const row = this.ctx.db.get('SELECT payload FROM outbox WHERE id = :id', { id: outboxId });
        return fromJson(row?.payload, {}).question ?? null;
    }
    /** One-line reminder attached to tool results so an active agent notices new work without polling. */
    notice() {
        const count = (sql) => this.ctx.db.get(sql).n;
        const urgent = count("SELECT count(*) AS n FROM inbox WHERE kind = 'enquiry' AND priority = 'urgent' AND state = 'open'");
        const open = count("SELECT count(*) AS n FROM inbox WHERE kind IN ('enquiry', 'conflict_report') AND priority != 'urgent' AND state = 'open'");
        const answers = count("SELECT count(*) AS n FROM inbox WHERE kind IN ('answer', 'receipt') AND state = 'unread'");
        const approvals = count("SELECT count(*) AS n FROM inbox WHERE state IN ('pending_approval', 'escalated')");
        const parts = [
            urgent ? `${urgent} URGENT enquiry(ies) waiting for your answer` : null,
            open ? `${open} request(s) waiting for your answer` : null,
            answers ? `${answers} answer(s)/receipt(s) for you` : null,
            approvals ? `${approvals} item(s) need your developer's approval` : null,
        ].filter(Boolean);
        return parts.length ? `[agent-network] ${parts.join('; ')}. Call get_inbox.` : null;
    }
    inboxItem(id) {
        const row = this.ctx.db.get('SELECT * FROM inbox WHERE id = :id', { id });
        if (!row)
            throw notFound(`No inbox item ${id}.`);
        return row;
    }
    // -------------------------------------------------------------------------
    // respond: the owning agent answers (no developer approval needed for read-only answers)
    // -------------------------------------------------------------------------
    async respond(input) {
        const now = iso(this.ctx.now());
        if (input.conflict_id)
            return this.respondToLocalConflict(input);
        if (!input.message_id)
            throw invalid('Pass message_id (from get_inbox) or conflict_id.');
        const item = this.inboxItem(input.message_id);
        if (item.state !== 'open')
            throw conflictError(`${item.id} is ${item.state}; only open items can be answered.`);
        if (item.component_id && !canWrite(this.ctx, this.identity, item.component_id))
            throw forbidden(`Only the owners of ${item.component_id} can answer this.`);
        const requester = this.node.activeMember(item.sender);
        if (item.kind === 'conflict_report') {
            if (input.action === 'escalate')
                return this.escalate(item, input);
            if (input.action !== 'answer' || !input.answer)
                throw invalid('Answer the conflict with a resolution (action "answer"), or escalate it.');
            return this.resolveConflict({ conflict_id: item.id, resolution: input.answer, outdated_sources: input.evidence });
        }
        if (item.kind !== 'enquiry')
            throw invalid(`${item.kind} items are decided by your developer (use decide), not answered.`);
        if (input.action === 'escalate')
            return this.escalate(item, input);
        const text = input.action === 'decline' ? (input.reason ?? input.answer) : input.answer;
        if (!text?.trim())
            throw invalid(input.action === 'decline' ? '"reason" is required when declining.' : '"answer" is required.');
        if (requester) {
            await this.reply(item.id, requester, {
                status: input.action === 'decline' ? 'declined' : 'answered',
                answer: text,
                evidence: input.evidence ?? [],
                confidence: input.confidence ?? null,
                decided_by_human: false,
                auto: input.auto ?? null,
            });
        }
        this.ctx.db.run('UPDATE inbox SET state = :state, handled_at = :now, handled_by = :by, auto = :auto WHERE id = :id', {
            state: input.action === 'decline' ? 'declined' : 'answered',
            now,
            by: describeActor(this.identity),
            auto: input.auto ? 1 : 0,
            id: item.id,
        });
        let published = null;
        const enquiry = fromJson(item.payload, {});
        if (input.action === 'answer' && (input.publish_as_context ?? true)) {
            published = recordAnswer(this.ctx, this.identity, { id: item.id, subject: enquiry.subject, question: enquiry.question, target_component: item.component_id }, { text, evidence: input.evidence ?? [], confidence: input.confidence ?? null, verified_against: input.verified_against ?? [] });
            await this.share();
        }
        audit(this.ctx, this.identity, `enquiry.${input.action}`, { request_id: item.id, subject: item.subject, details: { auto: !!input.auto } });
        return { message_id: item.id, state: input.action === 'decline' ? 'declined' : 'answered', delivered_to: requester?.id ?? null, shared_as_memory: published };
    }
    async escalate(item, input) {
        const summary = (input.summary ?? input.answer)?.trim();
        if (!summary)
            throw invalid('"summary" is required when escalating: explain what your developer must decide and why.');
        this.ctx.db.run("UPDATE inbox SET state = 'escalated', note = :note WHERE id = :id", {
            note: toJson({ summary, options: input.options ?? [], evidence: input.evidence ?? [], escalated_by: this.agent }),
            id: item.id,
        });
        if (item.kind === 'conflict_report')
            escalateConflict(this.ctx, item.id);
        const requester = this.node.activeMember(item.sender);
        if (requester) {
            await this.reply(item.id, requester, { status: 'escalated', answer: `Needs a decision from ${this.node.developer}: ${summary}`, evidence: input.evidence ?? [], confidence: null, decided_by_human: false });
        }
        return { message_id: item.id, state: 'escalated', next: 'Tell your developer (it is in get_inbox → awaiting_your_developer). Record their decision with decide.' };
    }
    async respondToLocalConflict(input) {
        const conflict = getConflict(this.ctx, input.conflict_id);
        assertWrite(this.ctx, this.identity, conflict.component_id, 'handle conflicts');
        if (input.action === 'answer') {
            if (!input.answer)
                throw invalid('"answer" (the resolution) is required.');
            return this.resolveConflict({ conflict_id: conflict.id, resolution: input.answer, outdated_sources: input.evidence });
        }
        if (input.action !== 'escalate')
            throw invalid('Local conflicts can be answered (resolved) or escalated.');
        const summary = input.summary ?? input.answer;
        if (!summary)
            throw invalid('"summary" is required when escalating.');
        escalateConflict(this.ctx, conflict.id);
        const id = `local-${conflict.id}`;
        this.ctx.db.run(`INSERT OR REPLACE INTO inbox (id, kind, priority, sender, subject, component_id, payload, state, created_at, received_at, note)
       VALUES (:id, 'conflict_escalation', 'normal', :me, :subject, :component, :payload, 'escalated', :now, :now, :note)`, {
            id,
            me: this.node.developer,
            subject: conflict.subject,
            component: conflict.component_id,
            payload: toJson({ conflict_id: conflict.id, description: conflict.description, sources: fromJson(conflict.sources, []) }),
            now: iso(this.ctx.now()),
            note: toJson({ summary, options: input.options ?? [], evidence: input.evidence ?? [] }),
        });
        return { item_id: id, state: 'escalated', next: 'Your developer decides this via decide (or the local dashboard).' };
    }
    // -------------------------------------------------------------------------
    // decide: record the developer's explicit decision on a queued item
    // -------------------------------------------------------------------------
    async decide(input, via = 'agent') {
        const item = this.inboxItem(input.item_id);
        const now = iso(this.ctx.now());
        const by = `${this.node.developer} via ${via === 'agent' ? this.agent : via}`;
        const payload = fromJson(item.payload, {});
        const sender = this.node.activeMember(item.sender);
        const mark = (state) => this.ctx.db.run('UPDATE inbox SET state = :state, decision = :decision, handled_at = :now, handled_by = :by WHERE id = :id', {
            state,
            decision: input.decision + (input.note ? `: ${input.note}` : ''),
            now,
            by,
            id: item.id,
        });
        const receipt = async (decision) => {
            if (!sender)
                return;
            await this.node.send({
                kind: 'receipt',
                priority: 'low',
                to: [sender],
                replyTo: item.id,
                payload: { item: item.id, decision, note: input.note ?? null, component: item.component_id },
            });
        };
        // Escalated questions and conflicts: the developer's decision becomes the answer.
        if (item.state === 'escalated') {
            const note = fromJson(item.note, {});
            let text = input.text?.trim() ?? '';
            if (input.option !== undefined) {
                const chosen = note.options?.[input.option - 1];
                if (!chosen)
                    throw invalid(`option must be between 1 and ${note.options?.length ?? 0}.`);
                text = text ? `${chosen} (${text})` : chosen;
            }
            if (!text)
                throw invalid('Provide the decision text (or an option number).');
            if (item.kind === 'conflict_report' || item.kind === 'conflict_escalation') {
                const conflictId = item.kind === 'conflict_report' ? item.id : payload.conflict_id;
                await this.resolveConflict({ conflict_id: conflictId, resolution: `Decision by ${this.node.developer}: ${text}` }, true);
                mark('answered');
                return { item_id: item.id, state: 'answered', decision: text };
            }
            if (sender) {
                await this.reply(item.id, sender, { status: 'answered', answer: `Decision by ${this.identity.name ?? this.node.developer}: ${text}`, evidence: [], confidence: 'high', decided_by_human: true });
            }
            recordAnswer(this.ctx, { ...this.identity, agent: via }, { id: item.id, subject: item.subject, question: payload.question ?? item.subject ?? '', target_component: item.component_id }, { text, evidence: [], confidence: 'high', verified_against: [] }, 'human');
            mark('answered');
            await this.share();
            return { item_id: item.id, state: 'answered', decision: text };
        }
        if (item.kind === 'graph_update' && item.state === 'pending_approval') {
            if (input.decision === 'approve') {
                if (!sender)
                    throw invalid(`${item.sender} is no longer an active member; the update cannot be verified any more.`);
                const applied = this.node.applyUpdateNow(payload.update, sender);
                mark('approved');
                return { item_id: item.id, state: 'approved', applied };
            }
            if (input.decision === 'reject' || input.decision === 'defer') {
                mark(input.decision === 'reject' ? 'rejected' : 'deferred');
                return { item_id: item.id, state: input.decision === 'reject' ? 'rejected' : 'deferred' };
            }
        }
        if (item.kind === 'change_notice' || item.kind === 'implementation_doc') {
            const notice = payload;
            if (input.decision === 'approve' && ['pending_approval', 'deferred'].includes(item.state)) {
                if (notice.doc || notice.summary) {
                    upsertEntry(this.ctx, {
                        subject: notice.subject,
                        component_id: notice.component,
                        type: item.kind,
                        title: notice.title,
                        data: { summary: notice.summary, doc: notice.doc, changes: notice.changes, approved_by: by },
                        source_kind: 'agent',
                        source_ref: item.id,
                        published_by: this.node.memberIdentity(item.sender, notice.agent),
                        origin: item.sender,
                    });
                }
                mark('approved');
                await receipt('approved');
                return {
                    item_id: item.id,
                    state: 'approved',
                    action: notice.action_required
                        ? `Implement the required changes for "${notice.title}" in ${item.component_id ?? 'your component'}, then call decide with decision "done".`
                        : 'Recorded in memory. No action required.',
                    details: { summary: notice.summary, changes: notice.changes, doc: notice.doc },
                };
            }
            if (input.decision === 'done' && item.state === 'approved') {
                mark('done');
                await receipt('done');
                return { item_id: item.id, state: 'done' };
            }
            if ((input.decision === 'reject' || input.decision === 'defer') && ['pending_approval', 'deferred'].includes(item.state)) {
                const state = input.decision === 'reject' ? 'rejected' : 'deferred';
                mark(state);
                await receipt(state);
                return { item_id: item.id, state };
            }
        }
        throw invalid(`Cannot "${input.decision}" a ${item.kind} item in state ${item.state}.`);
    }
}
//# sourceMappingURL=session.js.map