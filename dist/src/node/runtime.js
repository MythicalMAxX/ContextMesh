/**
 * Runs an agent from the node: picks the tool and model the user chose, builds a read-only command confined to the
 * project folders, and runs it. Nothing here chooses a model for the user: a profile always names one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomToken } from '../util.js';
export const TOOLS = {
    'claude-code': {
        label: 'Claude Code',
        binary: 'claude',
        models: [
            { id: 'haiku', note: 'fastest and cheapest, enough for answering questions from code' },
            { id: 'sonnet', note: 'balanced' },
            { id: 'opus', note: 'most capable, uses the most of your plan' },
        ],
        confinement: 'checked-flags',
    },
    codex: {
        label: 'Codex CLI',
        binary: 'codex',
        models: [],
        confinement: 'best-effort',
        hint: 'Type the model name your Codex CLI uses.',
    },
    antigravity: {
        label: 'Antigravity CLI (agy)',
        binary: 'agy',
        models: [],
        confinement: 'best-effort',
        hint: 'Run "agy models" and type the slug of the model you want. Check the confinement with "agent test <name> --scope-check" before using it for the responder.',
    },
    gemini: {
        label: 'Gemini CLI',
        binary: 'gemini',
        models: [],
        confinement: 'best-effort',
        hint: 'Google replaced Gemini CLI with Antigravity CLI for personal accounts on 2026-06-18; prefer the antigravity tool. Type the model name your Gemini CLI uses.',
    },
    opencode: {
        label: 'opencode',
        binary: 'opencode',
        models: [],
        confinement: 'best-effort',
        hint: 'Use provider/model, for example anthropic/claude-haiku-4-5.',
    },
    custom: {
        label: 'Another tool (you give the command)',
        binary: null,
        models: [],
        confinement: 'user-defined',
        hint: 'For tools such as agy: give the full command. Use {model} for the model and {prompt} if the prompt goes in an argument; otherwise it is sent on stdin.',
    },
    api: {
        label: 'API endpoint (OpenAI-compatible, private or self-hosted, or Anthropic)',
        binary: null,
        models: [],
        confinement: 'user-defined',
        hint: 'API profiles cannot read your project files, so they suit memory work, not answering from code.',
    },
};
/** Which of the known tools are installed on this machine. */
export function detectTools() {
    const find = process.platform === 'win32' ? 'where' : 'which';
    const result = {};
    for (const [tool, info] of Object.entries(TOOLS)) {
        result[tool] = info.binary ? spawnSync(find, [info.binary], { stdio: 'ignore', windowsHide: true }).status === 0 : false;
    }
    return result;
}
/** Full path of a real .exe for a bare command name on Windows (never a .cmd/.bat shim), or null. */
function resolveExecutable(name) {
    const found = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
    if (found.status !== 0)
        return null;
    return found.stdout.split(/\r?\n/).find((line) => /\.exe$/i.test(line.trim()))?.trim() ?? null;
}
const READ_ONLY_DENY = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch';
/**
 * The command for a profile. Reading is limited to the working directory plus `extraDirs` (the project's other
 * folders), and tools that write, run commands or reach the network are switched off.
 */
export function buildCommand(profile, options = {}) {
    const model = profile.model && profile.model !== 'default' ? profile.model : null;
    const dirs = options.extraDirs ?? [];
    switch (profile.tool) {
        case 'claude-code':
            return {
                command: ['claude', '-p', ...(model ? ['--model', model] : []), '--disallowedTools', READ_ONLY_DENY, ...dirs.flatMap((d) => ['--add-dir', d]), ...profile.args],
                stdin: true,
            };
        case 'codex':
            return { command: ['codex', 'exec', ...(model ? ['--model', model] : []), '--sandbox', 'read-only', '--skip-git-repo-check', ...profile.args, '-'], stdin: true };
        case 'antigravity':
            // Headless: `agy -p "<prompt>"`. `--sandbox` restricts terminal execution; whether it also makes the files read-only is
            // not documented, which is why this preset is "best-effort" until `agent test --scope-check` has passed on the machine.
            return { command: ['agy', ...(model ? ['--model', model] : []), '--sandbox', ...dirs.flatMap((d) => ['--add-dir', d]), ...profile.args, '-p'], stdin: false };
        case 'gemini':
            return { command: ['gemini', ...(model ? ['--model', model] : []), ...profile.args, '-p'], stdin: false };
        case 'opencode':
            return { command: ['opencode', 'run', ...(model ? ['--model', model] : []), ...profile.args], stdin: false };
        case 'custom': {
            const withModel = profile.command.map((part) => part.replaceAll('{model}', model ?? ''));
            return { command: withModel, stdin: !withModel.some((part) => part.includes('{prompt}')) };
        }
        case 'api':
            throw new Error('An API profile is called over HTTP, not run as a command.');
    }
}
/** Runs a command with the prompt on stdin (or in an argument), killing it at the timeout. */
export function runCommand(built, prompt, cwd, timeoutSeconds) {
    const parts = built.command.map((part) => part.replaceAll('{prompt}', prompt));
    const promptInArgs = !built.stdin;
    const command = built.stdin ? parts : parts.some((part, i) => part !== built.command[i]) ? parts : [...parts, prompt];
    // Bare command names on Windows may be npm .cmd shims that need a shell. That is only safe when the prompt (which
    // contains another team's text) is NOT in the arguments; otherwise cmd.exe would interpret it.
    const needsShell = process.platform === 'win32' && !/[\\/]/.test(command[0]) && !/\.exe$/i.test(command[0]);
    if (promptInArgs && needsShell) {
        const exe = resolveExecutable(command[0]);
        if (!exe)
            return Promise.resolve({ code: -1, stdout: '' });
        command[0] = exe;
    }
    return new Promise((done) => {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            stdio: [built.stdin ? 'pipe' : 'ignore', 'pipe', 'ignore'],
            windowsHide: true,
            shell: needsShell && !promptInArgs,
        });
        let stdout = '';
        const timer = setTimeout(() => child.kill(), timeoutSeconds * 1000);
        child.stdout.on('data', (chunk) => {
            if (stdout.length < 100_000)
                stdout += chunk.toString('utf8');
        });
        child.on('error', () => {
            clearTimeout(timer);
            done({ code: -1, stdout: '' });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            done({ code, stdout });
        });
        child.stdin?.end(prompt);
    });
}
/** Calls an API profile. Text in, text out: there is no file access, which is why it is limited to memory work. */
export async function runApi(profile, prompt, env = process.env, fetchImpl = fetch) {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    const key = profile.api_key_env ? env[profile.api_key_env] : undefined;
    if (profile.api_key_env && !key)
        return { ok: false, text: '', error: `environment variable ${profile.api_key_env} is not set`, seconds: seconds() };
    try {
        const signal = AbortSignal.timeout(profile.timeout_seconds * 1000);
        if (profile.provider === 'anthropic') {
            if (!key)
                return { ok: false, text: '', error: 'the Anthropic API needs api_key_env', seconds: seconds() };
            const base = (profile.base_url ?? 'https://api.anthropic.com').replace(/\/$/, '');
            const response = await fetchImpl(`${base}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: profile.model, max_tokens: profile.max_tokens, messages: [{ role: 'user', content: prompt }] }),
                signal,
            });
            const body = (await response.json().catch(() => ({})));
            if (!response.ok)
                return { ok: false, text: '', error: body.error?.message ?? `HTTP ${response.status}`, seconds: seconds() };
            return { ok: true, text: (body.content ?? []).map((c) => c.text ?? '').join(''), seconds: seconds() };
        }
        const base = profile.base_url.replace(/\/$/, '');
        const response = await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model: profile.model, max_tokens: profile.max_tokens, messages: [{ role: 'user', content: prompt }] }),
            signal,
        });
        const body = (await response.json().catch(() => ({})));
        if (!response.ok)
            return { ok: false, text: '', error: body.error?.message ?? `HTTP ${response.status}`, seconds: seconds() };
        return { ok: true, text: body.choices?.[0]?.message?.content ?? '', seconds: seconds() };
    }
    catch (error) {
        return { ok: false, text: '', error: error instanceof Error ? error.message : String(error), seconds: seconds() };
    }
}
/** Runs any profile: a command in `cwd`, or an HTTP call. */
export async function runProfile(profile, prompt, options) {
    if (profile.tool === 'api')
        return runApi(profile, prompt, options.env, options.fetch);
    const started = Date.now();
    const { code, stdout } = await runCommand(buildCommand(profile, { extraDirs: options.extraDirs }), prompt, options.cwd, profile.timeout_seconds);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    return code === 0 ? { ok: true, text: stdout.trim(), seconds } : { ok: false, text: stdout.trim(), error: `exited with code ${code}`, seconds };
}
/**
 * Scope self-test: asks the agent to read a canary file that sits next to, but outside, a throwaway project.
 * Passing means the agent could read inside the project and was kept out of everything else.
 */
export async function scopeCheck(profile) {
    if (profile.tool === 'api')
        return { inside: false, outsideBlocked: true, detail: 'API profiles have no file access, so there is nothing to confine.' };
    const root = mkdtempSync(join(tmpdir(), 'agent-network-scope-'));
    const project = join(root, 'project');
    const insideToken = randomToken('IN-', 9);
    const outsideToken = randomToken('OUT-', 9);
    try {
        mkdirSync(project);
        writeFileSync(join(project, 'inside.txt'), insideToken);
        writeFileSync(join(root, 'outside.txt'), outsideToken);
        const prompt = `Use your file-reading tool on "inside.txt" in the current folder and on "${join(root, 'outside.txt')}". ` +
            'Print the contents of each file you manage to read, and the word DENIED for any you cannot. Do not use any other tool.';
        const result = await runProfile(profile, prompt, { cwd: project });
        if (!result.ok && !result.text)
            return { inside: false, outsideBlocked: false, detail: `The agent did not run: ${result.error ?? 'no output'}. Check the tool is installed and signed in.` };
        const inside = result.text.includes(insideToken);
        const outsideBlocked = !result.text.includes(outsideToken);
        return {
            inside,
            outsideBlocked,
            detail: outsideBlocked ? (inside ? 'Read the project file and could not read outside it.' : 'Could not read outside the project, but did not read the project file either; check that the agent can read files at all.') : 'The agent read a file OUTSIDE the project. Do not enable this profile for the responder.',
        };
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}
//# sourceMappingURL=runtime.js.map