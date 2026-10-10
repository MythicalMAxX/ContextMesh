/**
 * Relationship checks (docs/RELATIONSHIPS.md). The question is always the same: may this asker put a question about this component
 * to its owners, and if so, what may the answer draw on and may it go out without a person? The receiving node asks it with its
 * own signed copy of the manifest; the sender asks it too, only so an agent hears "no" at once instead of after a round trip.
 */
import { isWholeComponent } from './glob.js';
import { canRead, componentOwners, getComponent } from './registry.js';
const today = (now) => now.toISOString().slice(0, 10);
/** May `asker` ask about `componentId`? Components are checked against the manifest this node currently holds. */
export function authorizeAsk(ctx, asker, componentId, now = ctx.now()) {
    const component = componentId ? getComponent(ctx, componentId) : null;
    if (!component)
        return { allowed: false, code: 'unknown_component', reason: `There is no component "${componentId ?? ''}" in this org.` };
    if (!canRead(ctx, asker, component.id)) {
        return { allowed: false, code: 'no_access', reason: `${asker.developer} does not have access to ${component.id}.` };
    }
    const strict = ctx.config.policy.relationships === 'strict';
    if (!strict)
        return { allowed: true, via: 'open', relationship: null, answers: 'auto', scope: null };
    const ownTeam = asker.teams.includes(component.team_id);
    if (asker.admin || ownTeam || componentOwners(ctx, component.id).includes(asker.developer)) {
        return { allowed: true, via: 'implicit', relationship: null, answers: 'auto', scope: null };
    }
    const matching = Object.entries(ctx.config.relationships).filter(([, r]) => r.about.components.includes(component.id) &&
        r.may.includes('ask') &&
        (r.from.developers.includes(asker.developer) || r.from.teams.some((team) => asker.teams.includes(team))));
    if (matching.length === 0) {
        return { allowed: false, code: 'no_relationship', reason: `${asker.developer} has no relationship with the owners of ${component.id}, so this question cannot be answered. Ask your own person to arrange one.` };
    }
    const current = matching.filter(([, r]) => !r.expires || r.expires >= today(now));
    if (current.length === 0) {
        return { allowed: false, code: 'expired', reason: `The relationship that allowed ${asker.developer} to ask about ${component.id} has expired.` };
    }
    // Several grants add up: the files they allow are combined, and answers go out by themselves only if every one of them says so.
    const scopes = current.map(([, r]) => r.scope ?? null);
    const scope = scopes.some((s) => s === null || isWholeComponent(s)) ? ['**'] : [...new Set(scopes.flatMap((s) => s ?? []))];
    return {
        allowed: true,
        via: 'relationship',
        relationship: current.map(([name]) => name).join(', '),
        answers: current.every(([, r]) => r.answers === 'auto') ? 'auto' : 'approval',
        scope,
    };
}
export const DENIAL_HELP = {
    no_access: 'The component is restricted and your person is not among its readers.',
    no_relationship: 'There is no relationship that lets you ask. Do not look for another way to the answer; tell your person once what you are missing.',
    expired: 'The relationship has ended. Tell your person once; do not retry.',
    rate_limited: 'Too many questions in a short time. Stop asking and tell your person what you are waiting for.',
    unknown_component: 'Use find_owner to see who is responsible.',
};
//# sourceMappingURL=relationships.js.map