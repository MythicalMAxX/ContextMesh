/** Where a piece of engineering knowledge came from. Different sources represent different kinds of truth. */
export const SOURCE_KINDS = ['openapi', 'code', 'tests', 'doc', 'pr', 'task', 'chat', 'agent', 'human'];
/** Sources that describe what the system actually does or what a human decided, as opposed to intent or hearsay. */
export const AUTHORITATIVE_SOURCES = new Set(['openapi', 'code', 'tests', 'human']);
export const SYSTEM_IDENTITY = {
    developer: 'system',
    name: 'agent-network',
    teams: [],
    admin: true,
    agent: 'agent-network',
    repository: null,
    component: null,
    task: null,
};
// ---------------------------------------------------------------------------
// Facts: atomic, comparable claims used for conflict detection.
// ---------------------------------------------------------------------------
export const FACT_PROPERTIES = ['required', 'nullable', 'type', 'enum'];
export const FACT_LOCATIONS = ['request', 'response', '*'];
//# sourceMappingURL=types.js.map