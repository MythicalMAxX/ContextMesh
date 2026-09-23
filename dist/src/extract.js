const ENDPOINT_IN_TEXT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"),;]*)/gi;
export function extractEndpoints(text) {
    const seen = new Set();
    const endpoints = [];
    for (const match of text.matchAll(ENDPOINT_IN_TEXT)) {
        const method = match[1].toUpperCase();
        const path = match[2].replace(/[.:]+$/, '');
        const key = `${method} ${path}`;
        if (!seen.has(key)) {
            seen.add(key);
            endpoints.push({ method, path });
        }
    }
    return endpoints;
}
const NOT_FIELDS = new Set([
    'it', 'this', 'that', 'field', 'fields', 'value', 'values', 'the', 'which', 'and', 'or', 'response', 'request',
    'endpoint', 'api', 'everything', 'nothing', 'all', 'each', 'one', 'data', 'body', 'payload', 'param', 'parameter',
    'is', 'be', 'also', 'still', 'now', 'there', 'they', 'these', 'those', 'page', 'ui', 'task',
]);
const FIELD = '`?([A-Za-z_][A-Za-z0-9_.]*)`?';
const ITEM = '[`\'"]?[A-Za-z_][\\w-]*[`\'"]?';
const LIST = `(${ITEM}(?:\\s*(?:,|\\||/|\\bor\\b|\\band\\b)\\s*(?:or\\s+|and\\s+)?${ITEM})+)`;
const RULES = [
    {
        // "cloud_account_id is optional", "`region` should be nullable", "name is mandatory"
        re: new RegExp(`${FIELD}\\s+(?:is|are|should be|must be|will be|stays|remains)\\s+(?:an?\\s+)?(optional|required|mandatory|nullable|non-nullable|not nullable)\\b`, 'gi'),
        facts: (m) => {
            const word = m[2].toLowerCase();
            if (word === 'optional')
                return [{ property: 'required', value: false }];
            if (word === 'required' || word === 'mandatory')
                return [{ property: 'required', value: true }];
            if (word === 'nullable')
                return [{ property: 'nullable', value: true }];
            return [{ property: 'nullable', value: false }];
        },
    },
    {
        // "region is not required", "status is not nullable"
        re: new RegExp(`${FIELD}\\s+(?:is|are)\\s+not\\s+(required|nullable|optional)\\b`, 'gi'),
        facts: (m) => {
            const word = m[2].toLowerCase();
            if (word === 'required')
                return [{ property: 'required', value: false }];
            if (word === 'optional')
                return [{ property: 'required', value: true }];
            return [{ property: 'nullable', value: false }];
        },
    },
    {
        // "region can be null", "description may be omitted"
        re: new RegExp(`${FIELD}\\s+(?:can|may|might|could)\\s+be\\s+(null|omitted|missing)\\b`, 'gi'),
        facts: (m) => (m[2].toLowerCase() === 'null' ? [{ property: 'nullable', value: true }] : [{ property: 'required', value: false }]),
    },
    {
        // "region cannot be null", "name must not be omitted"
        re: new RegExp(`${FIELD}\\s+(?:cannot|can't|can not|must not|should not|will never|is never|never)\\s+be\\s+(null|omitted|missing)\\b`, 'gi'),
        facts: (m) => (m[2].toLowerCase() === 'null' ? [{ property: 'nullable', value: false }] : [{ property: 'required', value: true }]),
    },
    {
        // "optional field `x`", "required parameter `x`" (backticks required to limit noise)
        re: /\b(optional|required|mandatory)\s+(?:field\s+|param(?:eter)?\s+|property\s+)?`([A-Za-z_][A-Za-z0-9_.]*)`/gi,
        fieldGroup: 2,
        facts: (m) => [{ property: 'required', value: m[1].toLowerCase() !== 'optional' }],
    },
    {
        // "status is one of: active, inactive", "status values: active | inactive"
        re: new RegExp(`${FIELD}\\s+(?:is\\s+one\\s+of|can\\s+be\\s+one\\s+of|must\\s+be\\s+one\\s+of|values?(?:\\s+are)?|one\\s+of)\\s*:?\\s*${LIST}`, 'gi'),
        facts: (m) => [
            {
                property: 'enum',
                value: m[2]
                    .split(/\s*(?:,|\||\/|\bor\b|\band\b)\s*/)
                    .map((v) => v.replace(/[`'"]/g, '').trim())
                    .filter(Boolean),
            },
        ],
    },
];
/** Extracts field-level claims from free text. Location is "*" because prose rarely says request vs response. */
export function extractTaskFacts(text) {
    const facts = [];
    const seen = new Set();
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
        for (const rule of RULES) {
            for (const match of sentence.matchAll(rule.re)) {
                const field = match[rule.fieldGroup ?? 1];
                if (NOT_FIELDS.has(field.toLowerCase()))
                    continue;
                for (const fact of rule.facts(match)) {
                    const key = `${field}|${fact.property}|${JSON.stringify(fact.value)}`;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    facts.push({ field, location: '*', source: 'task', evidence: sentence.trim().slice(0, 200), ...fact });
                }
            }
        }
    }
    return facts;
}
//# sourceMappingURL=extract.js.map