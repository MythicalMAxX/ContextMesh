/**
 * Project scope and agent runtime (client-side, no hub needed): agents get a boundary and a map instead of exploring the
 * machine, and the model that background work uses is always an explicit choice.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadNodeConfig, parseNodeConfig } from '../src/config.ts';
import { buildCommand, runApi, runCommand } from '../src/node/runtime.ts';
import { addProfile, addProject, removeProject, runSetup, scopeBlockFor, setWorkspace, useWorkspace, withScopeBlock, type SetupIo } from '../src/node/setup.ts';
import { currentProject, insideRoots, scopeRuleBlock, validateProjectPath } from '../src/scope.ts';

const base = { hub: 'http://localhost:1', org: 'acme', developer: 'dev' };
const tmp = () => mkdtempSync(join(tmpdir(), 'agent-network-scope-'));

describe('node configuration: projects and agent profiles', () => {
  it('accepts projects, workspaces and profiles with an explicit model', () => {
    const config = parseNodeConfig(
      {
        ...base,
        projects: { billing: { description: 'Invoices', paths: ['/work/billing', '/work/billing-docs'], repository: 'billing-service' } },
        workspaces: { main: { projects: ['billing'] } },
        workspace: 'main',
        agents: { profiles: { cheap: { tool: 'claude-code', model: 'haiku' } } },
        responder: { enabled: true, profile: 'cheap' },
      },
      '/node',
    );
    assert.equal(config.projects.billing!.paths.length, 2);
    assert.equal(config.responder.max_per_day, 100);
  });

  it('refuses a profile without a model: there is no silent default', () => {
    assert.throws(() => parseNodeConfig({ ...base, agents: { profiles: { p: { tool: 'claude-code' } } } }, '/node'), /choose a model/);
    assert.throws(() => parseNodeConfig({ ...base, agents: { profiles: { p: { tool: 'custom' } } } }, '/node'), /full command/);
    assert.throws(() => parseNodeConfig({ ...base, agents: { profiles: { p: { tool: 'api', model: 'm' } } } }, '/node'), /provider/);
  });

  it('catches references to things that do not exist', () => {
    assert.throws(() => parseNodeConfig({ ...base, workspaces: { w: { projects: ['nope'] } } }, '/node'), /unknown project "nope"/);
    assert.throws(() => parseNodeConfig({ ...base, workspace: 'nope' }, '/node'), /unknown workspace/);
    assert.throws(() => parseNodeConfig({ ...base, responder: { profile: 'nope' } }, '/node'), /unknown profile/);
  });

  it('keeps repositories inside the declared projects once any project exists', () => {
    const projects = { a: { paths: ['/work/a'] } };
    assert.throws(() => parseNodeConfig({ ...base, projects, repositories: { r: { path: '/elsewhere/r' } } }, '/node'), /outside every project/);
    assert.doesNotThrow(() => parseNodeConfig({ ...base, projects, repositories: { r: { path: '/work/a/sub' } } }, '/node'));
    // Without projects nothing is restricted yet (existing nodes keep working).
    assert.doesNotThrow(() => parseNodeConfig({ ...base, repositories: { r: { path: '/anywhere' } } }, '/node'));
  });
});

describe('scope boundaries', () => {
  it('refuses a drive root, the home folder and anything that contains it', () => {
    assert.throws(() => validateProjectPath(homedir()), /home folder/);
    assert.throws(() => validateProjectPath(resolve(homedir(), '..')), /home folder|whole drive/);
    assert.throws(() => validateProjectPath(resolve(homedir(), '..', '..')), /home folder|whole drive/);
    assert.throws(() => validateProjectPath(join(tmp(), 'missing')), /not found/);
  });

  it('accepts an ordinary project folder', () => {
    const dir = tmp();
    assert.equal(validateProjectPath(dir), realpathSync.native(dir), 'the real path is stored, so it matches wherever an agent starts');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let a link inside a project reach outside it', () => {
    const root = tmp();
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(project, 'link'), 'junction');
    assert.equal(insideRoots([project], join(project, 'file.txt')), true, 'files that do not exist yet are judged by their folder');
    assert.equal(insideRoots([project], join(project, 'link', 'secret.txt')), false, 'a link to a folder outside is not inside');
    assert.equal(insideRoots([project], join(outside, 'secret.txt')), false);
    assert.equal(insideRoots([project], join(project, '..', 'outside', 'secret.txt')), false, '.. cannot climb out');
    rmSync(root, { recursive: true, force: true });
  });

  it('knows which project a folder belongs to', () => {
    const settings = { baseDir: '/n', workspaces: {}, workspace: undefined, projects: { api: { description: '', paths: ['/w/api'] }, web: { description: '', paths: ['/w/api/web'] } } };
    assert.equal(currentProject(settings, '/w/api/src')?.name, 'api');
    assert.equal(currentProject(settings, '/w/api/web/src')?.name, 'web', 'the most specific project wins');
    assert.equal(currentProject(settings, '/elsewhere'), null);
  });

  it('writes the scope block once and refreshes it in place', () => {
    const projects = [{ name: 'api', description: 'Payments API', paths: ['/w/api'], repository: null, notes: 'make test' }];
    const block = scopeRuleBlock(projects);
    assert.match(block, /Payments API/);
    assert.match(block, /Work only inside: \/w\/api/);
    const once = withScopeBlock('# Team rules\n\nBe kind.\n', block);
    assert.match(once, /# Team rules[\s\S]*Be kind\.[\s\S]*agent-network:scope:start/);
    const updated = withScopeBlock(once, scopeRuleBlock([{ ...projects[0]!, description: 'Billing API' }]));
    assert.equal(updated.split('agent-network:scope:start').length, 2, 'never duplicated');
    assert.match(updated, /Billing API/);
    assert.doesNotMatch(updated, /Payments API/);
    assert.match(updated, /Be kind\./);
  });
});

describe('agent runtime', () => {
  it('always passes the chosen model, keeps tools read-only and adds only the project folders', () => {
    const { command } = buildCommand({ tool: 'claude-code', model: 'haiku', args: [], max_tokens: 1024, timeout_seconds: 120 }, { extraDirs: ['/w/docs'] });
    assert.deepEqual(command.slice(0, 4), ['claude', '-p', '--model', 'haiku']);
    assert.ok(command.includes('--disallowedTools'));
    assert.match(command[command.indexOf('--disallowedTools') + 1]!, /Bash,Edit,Write/);
    assert.deepEqual(command.slice(-2), ['--add-dir', '/w/docs']);
    assert.ok(!command.includes('--allowedTools'), 'no blanket Read permission, so reading stays limited to the project');
  });

  it('"default" deliberately leaves the model to the tool; nothing else does', () => {
    const { command } = buildCommand({ tool: 'claude-code', model: 'default', args: [], max_tokens: 1, timeout_seconds: 1 });
    assert.ok(!command.includes('--model'));
  });

  it('runs Antigravity CLI headlessly with the chosen model, the sandbox flag and only the project folders', () => {
    const built = buildCommand({ tool: 'antigravity', model: 'some-model', args: [], max_tokens: 1, timeout_seconds: 1 }, { extraDirs: ['/w/docs'] });
    assert.deepEqual(built.command, ['agy', '--model', 'some-model', '--sandbox', '--add-dir', '/w/docs', '-p']);
    assert.equal(built.stdin, false, 'the prompt follows -p as an argument');
    assert.ok(!buildCommand({ tool: 'antigravity', model: 'default', args: [], max_tokens: 1, timeout_seconds: 1 }).command.includes('--model'));
  });

  it('builds a command for any other tool you describe (for example agy)', () => {
    const profile = { tool: 'custom' as const, model: 'fast-1', command: ['agy', '--model', '{model}', '--ask', '{prompt}'], args: [], max_tokens: 1, timeout_seconds: 1 };
    const built = buildCommand(profile);
    assert.deepEqual(built.command, ['agy', '--model', 'fast-1', '--ask', '{prompt}']);
    assert.equal(built.stdin, false, 'a {prompt} placeholder means the prompt goes in the argument, not stdin');
    assert.equal(buildCommand({ ...profile, command: ['agy', '-m', '{model}'] }).stdin, true);
  });

  it('runs a command with the prompt on stdin or in an argument', async () => {
    const dir = tmp();
    const script = join(dir, 'echo.mjs');
    writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('stdin:'+s+' arg:'+(process.argv[2]??'')));if(process.stdin.isTTY)console.log('arg:'+process.argv[2]);");
    const viaStdin = await runCommand({ command: [process.execPath, script], stdin: true }, 'hello', dir, 20);
    assert.match(viaStdin.stdout, /stdin:hello/);
    const viaArg = await runCommand({ command: [process.execPath, '-e', 'console.log("arg:"+process.argv[1])', '{prompt}'], stdin: false }, 'hello there', dir, 20);
    assert.match(viaArg.stdout, /arg:hello there/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls OpenAI-compatible and Anthropic endpoints, with the key from the environment only', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(String(url).includes('anthropic') ? { content: [{ type: 'text', text: 'hi from claude' }] } : { choices: [{ message: { content: 'hi from local' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const local = { tool: 'api' as const, provider: 'openai-compatible' as const, base_url: 'http://localhost:11434/v1/', model: 'llama3', args: [], max_tokens: 50, timeout_seconds: 5 };
    const a = await runApi(local, 'ping', {}, fake);
    assert.deepEqual([a.ok, a.text], [true, 'hi from local']);
    assert.equal(calls[0]!.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[0]!.headers.authorization, undefined, 'a local server needs no key');

    const missing = await runApi({ ...local, api_key_env: 'NOPE_KEY' }, 'ping', {}, fake);
    assert.equal(missing.ok, false);
    assert.match(missing.error!, /NOPE_KEY is not set/);

    const b = await runApi({ ...local, provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key_env: 'K', model: 'claude-haiku-4-5' }, 'ping', { K: 'sk-test' }, fake);
    assert.deepEqual([b.ok, b.text], [true, 'hi from claude']);
    assert.equal(calls[1]!.headers['x-api-key'], 'sk-test');
    assert.equal(calls[1]!.body.model, 'claude-haiku-4-5');
  });
});

describe('setup', () => {
  const home = tmp();
  const projectDir = join(home, 'work', 'shop');
  const docsDir = join(home, 'work', 'shop-docs');
  before(() => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(home, 'node.yaml'), '# my node\nhub: http://localhost:1\norg: acme\ndeveloper: dev\n');
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  it('adds projects, extra folders, workspaces and profiles, keeping comments and validating as it goes', () => {
    const first = addProject(home, { path: projectDir, description: 'The shop frontend', notes: 'npm test' });
    assert.equal(first.name, 'shop');
    addProject(home, { path: docsDir, name: 'shop' });
    assert.equal(loadNodeConfig(join(home, 'node.yaml')).projects.shop!.paths.length, 2);
    assert.equal(loadNodeConfig(join(home, 'node.yaml')).projects.shop!.description, 'The shop frontend');
    setWorkspace(home, 'main', ['shop'], 'Everything for the shop');
    useWorkspace(home, 'main');
    addProfile(home, 'background', { tool: 'claude-code', model: 'haiku' }, 'responder');
    const config = loadNodeConfig(join(home, 'node.yaml'));
    assert.equal(config.workspace, 'main');
    assert.equal(config.responder.profile, 'background');
    assert.match(readFileSync(join(home, 'node.yaml'), 'utf8'), /# my node/);
    assert.match(scopeBlockFor(config).block, /Work only inside/);
  });

  it('rejects an invalid change without touching the file', () => {
    const before = readFileSync(join(home, 'node.yaml'), 'utf8');
    assert.throws(() => addProfile(home, 'bad', { tool: 'claude-code' }), /choose a model/);
    assert.throws(() => addProject(home, { path: homedir(), name: 'everything' }), /home folder/);
    assert.equal(readFileSync(join(home, 'node.yaml'), 'utf8'), before);
  });

  it('removes a project and the workspaces that only contained it', () => {
    removeProject(home, 'shop');
    const config = loadNodeConfig(join(home, 'node.yaml'));
    assert.deepEqual(config.projects, {});
    assert.deepEqual(config.workspaces, {});
    assert.equal(config.workspace, undefined);
  });

  it('walks a non-technical person through it in plain language', async () => {
    const answers = [projectDir, 'shop', 'The online shop', 'n', '', ''];
    const said: string[] = [];
    const io: SetupIo = { say: (t) => void said.push(t), ask: async (_q, fallback) => answers.shift() || fallback || '' };
    await runSetup(home, io, projectDir);
    assert.match(said.join('\n'), /never go searching your whole computer/);
    assert.match(said.join('\n'), /Skipped\. Background work stays off/);
    assert.equal(loadNodeConfig(join(home, 'node.yaml')).projects.shop!.description, 'The online shop');
  });

  it('does not loop forever when the suggested folder is not allowed', async () => {
    // Pressing Enter accepts the suggestion (the home folder), which is refused; Enter again moves on.
    const answers = ['', ''];
    const said: string[] = [];
    const io: SetupIo = { say: (t) => void said.push(t), ask: async (_q, fallback) => answers.shift() || fallback || '' };
    await runSetup(home, io, homedir());
    assert.match(said.join('\n'), /home folder/);
  });
});
