import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { validateManifest } from '../src/config.ts';
import { contractFacts, diffContracts, parseOpenApi } from '../src/contracts.ts';
import { extractEndpoints, extractTaskFacts } from '../src/extract.ts';
import { adfToText } from '../src/indexers/tasks.ts';
import { codeownersRegex, matchCodeowners, parseCodeowners } from '../src/registry.ts';
import { endpointMatches, parseEndpoint, subjectKey, tokens } from '../src/subjects.ts';
import type { Contract } from '../src/types.ts';
import { EXAMPLES } from './helpers.ts';

const loadSpec = (repo: string) => parseOpenApi(parseYaml(readFileSync(join(EXAMPLES, 'repos', repo, 'openapi.yaml'), 'utf8')));

describe('OpenAPI extraction', () => {
  const spec = loadSpec('resource-service');
  const byKey = new Map(spec.contracts.map((c) => [`${c.method} ${c.path}`, c]));

  it('extracts every operation with auth, params and error codes', () => {
    assert.deepEqual([...byKey.keys()].sort(), ['GET /api/resources', 'GET /api/resources/{resource_id}', 'POST /api/resources']);
    const details = byKey.get('GET /api/resources/{resource_id}')!;
    assert.deepEqual(details.auth, ['bearer']);
    assert.equal(details.params?.resource_id?.required, true);
    assert.deepEqual(details.errors?.sort(), ['PERMISSION_DENIED', 'RESOURCE_NOT_FOUND']);
  });

  it('resolves $refs and keeps nullability, required-ness and enums', () => {
    const fields = byKey.get('GET /api/resources/{resource_id}')!.responses!['200']!.fields!;
    assert.equal(fields.region?.nullable, true);
    assert.equal(fields.region?.required, false);
    assert.equal(fields.cloud_account_id?.required, true);
    assert.deepEqual(fields.status?.enum, ['ACTIVE', 'INACTIVE', 'DELETED']);
    const request = byKey.get('POST /api/resources')!.request!.fields;
    assert.equal(request.cloud_account_id?.required, true);
    assert.deepEqual(byKey.get('POST /api/resources')!.errors?.sort(), ['INVALID_CLOUD_ACCOUNT', 'VALIDATION_FAILED']);
  });

  it('flattens arrays of objects and understands OpenAPI 3.1 null types', () => {
    const list = byKey.get('GET /api/resources')!.responses!['200']!.fields!;
    assert.equal(list['items[].status']?.type, 'string');
    assert.equal(list.next_cursor?.nullable, true);
    const recommendations = loadSpec('recommendation-engine').contracts[0]!;
    assert.deepEqual(recommendations.auth, ['api_key (header: X-Api-Key)']);
    assert.equal(recommendations.responses!['200']!.fields!['recommendations[].confidence']?.nullable, true);
  });

  it('turns contracts into comparable facts', () => {
    const facts = contractFacts(byKey.get('POST /api/resources')!);
    assert.ok(facts.some((f) => f.field === 'cloud_account_id' && f.property === 'required' && f.value === true && f.location === 'request'));
    assert.ok(facts.some((f) => f.field === 'status' && f.property === 'enum' && f.location === 'response'));
  });
});

describe('contract diff', () => {
  const base: Contract = {
    method: 'POST',
    path: '/api/resources',
    request: { fields: { name: { type: 'string', required: true }, resource_type: { type: 'string', required: false } } },
    responses: { '201': { fields: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }, region: { type: 'string', nullable: false } } } },
  };

  it('classifies optional → required on requests as breaking', () => {
    const next = structuredClone(base);
    next.request!.fields.resource_type!.required = true;
    const [change] = diffContracts(base, next);
    assert.equal(change?.severity, 'breaking');
    assert.equal(change?.change, 'optional → required');
  });

  it('flags new response enum values and newly nullable fields', () => {
    const next = structuredClone(base);
    next.responses!['201']!.fields!.status!.enum = ['ACTIVE', 'INACTIVE', 'DELETED'];
    next.responses!['201']!.fields!.region!.nullable = true;
    const changes = diffContracts(base, next);
    assert.deepEqual(
      changes.map((c) => [c.field, c.severity]),
      [
        ['status', 'potentially_breaking'],
        ['region', 'breaking'],
      ],
    );
  });

  it('treats removed response fields as breaking and new optional inputs as safe', () => {
    const next = structuredClone(base);
    delete next.responses!['201']!.fields!.region;
    next.request!.fields.tags = { type: 'array', required: false };
    const severities = Object.fromEntries(diffContracts(base, next).map((c) => [c.field, c.severity]));
    assert.deepEqual(severities, { tags: 'non_breaking', region: 'breaking' });
  });
});

describe('task text extraction', () => {
  it('finds endpoints and field claims in prose', () => {
    const text = 'Form that submits POST /api/resources.\n`cloud_account_id` is optional. `region` can be null. status is one of: active, inactive.';
    assert.deepEqual(extractEndpoints(text), [{ method: 'POST', path: '/api/resources' }]);
    const facts = extractTaskFacts(text).map((f) => [f.field, f.property, f.value]);
    assert.deepEqual(facts, [
      ['cloud_account_id', 'required', false],
      ['region', 'nullable', true],
      ['status', 'enum', ['active', 'inactive']],
    ]);
  });

  it('handles negations and ignores non-field words', () => {
    const facts = extractTaskFacts('The name must not be omitted. It is required. region is not nullable. Required field `sku`.');
    assert.deepEqual(
      facts.map((f) => [f.field, f.property, f.value]),
      [
        ['name', 'required', true],
        ['region', 'nullable', false],
        ['sku', 'required', true],
      ],
    );
  });

  it('flattens Jira ADF descriptions', () => {
    const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Uses ' }, { type: 'text', text: 'GET /api/x' }] }, { type: 'paragraph', content: [{ type: 'text', text: '`id` is required' }] }] };
    assert.equal(adfToText(adf), 'Uses GET /api/x\n`id` is required\n');
  });
});

describe('CODEOWNERS', () => {
  const rules = parseCodeowners('# comment\n*  @acme/backend\n/openapi.yaml @spec-owner\ndocs/ @docs\n**/migrations/ @dba\n*.go @gophers # trailing comment\n');

  it('matches like GitHub, last rule wins', () => {
    assert.deepEqual(matchCodeowners(rules, 'README.md')?.owners, ['@acme/backend']);
    assert.deepEqual(matchCodeowners(rules, 'openapi.yaml')?.owners, ['@spec-owner']);
    assert.deepEqual(matchCodeowners(rules, 'services/openapi.yaml')?.owners, ['@acme/backend']);
    assert.deepEqual(matchCodeowners(rules, 'docs/guide/intro.md')?.owners, ['@docs']);
    assert.deepEqual(matchCodeowners(rules, 'db/migrations/001.sql')?.owners, ['@dba']);
    assert.deepEqual(matchCodeowners(rules, 'internal/handler.go')?.owners, ['@gophers']);
  });

  it('anchors patterns that contain a slash', () => {
    assert.ok(codeownersRegex('/build/').test('build/out.txt'));
    assert.ok(!codeownersRegex('/build/').test('src/build/out.txt'));
    assert.ok(codeownersRegex('build/').test('build/out.txt'));
  });
});

describe('subjects', () => {
  it('normalizes path parameter styles', () => {
    assert.equal(subjectKey('get /api/resources/{resource_id}'), 'GET /api/resources/{}');
    assert.equal(subjectKey('GET /api/resources/:id/'), 'GET /api/resources/{}');
    assert.equal(subjectKey('/api/resources/{id}'), '* /api/resources/{}');
    assert.equal(subjectKey('ui-492'), 'UI-492');
    assert.equal(subjectKey('  Resource   Details '), 'resource details');
  });

  it('matches concrete paths and optionally ignores API versions', () => {
    assert.ok(endpointMatches('GET /api/resources/{}', parseEndpoint('GET /api/resources/123')!));
    assert.ok(!endpointMatches('GET /api/resources/{}', parseEndpoint('POST /api/resources/123')!));
    assert.ok(endpointMatches('GET /api/resources/{}', parseEndpoint('/api/resources/abc')!));
    assert.ok(!endpointMatches('GET /api/resources/{}', parseEndpoint('GET /api/v2/resources/1')!));
    assert.ok(endpointMatches('GET /api/resources/{}', parseEndpoint('GET /api/v2/resources/1')!, { ignoreVersion: true }));
  });

  it('tokenizes with light stemming and stop words', () => {
    assert.deepEqual(tokens('resource-details-api'), ['resource', 'detail']);
    assert.deepEqual(tokens('getResourceDetails'), ['get', 'resource', 'detail']);
  });
});

describe('manifest', () => {
  it('reports unknown references', () => {
    assert.throws(
      () => validateManifest({ teams: { a: {} }, developers: { x: { teams: ['b'] } }, components: { c: { team: 'a', owners: ['y'], readers: ['z'] } } }),
      (error: Error) => /unknown team "b"/.test(error.message) && /unknown owner "y"/.test(error.message) && /unknown reader team "z"/.test(error.message),
    );
  });

  it('accepts the example org and applies defaults', () => {
    const manifest = validateManifest(parseYaml(readFileSync(join(EXAMPLES, 'org.yaml'), 'utf8')));
    assert.equal(manifest.components['payroll-service']?.visibility, 'restricted');
    assert.equal(manifest.components['resource-service']?.visibility, 'org');
    assert.deepEqual(manifest.components['mobile-app']?.consumes, ['resource-service']);
  });
});
