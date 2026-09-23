import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';

export const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** Copies the example repositories into a temp dir and turns each into a git repo. */
export function createWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-network-'));
  cpSync(join(EXAMPLES, 'repos'), join(dir, 'repos'), { recursive: true });
  cpSync(join(EXAMPLES, 'tasks.yaml'), join(dir, 'tasks.yaml'));
  for (const repo of readdirSync(join(dir, 'repos'))) {
    const repoDir = join(dir, 'repos', repo);
    git(repoDir, 'init', '-q');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-q', '-m', 'initial');
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows may still hold SQLite files briefly; the OS cleans temp dirs eventually.
      }
    },
  };
}

/** Merges settings into a node's node.yaml (repositories, tasks, responder, ...). */
export function configureNode(home: string, settings: Record<string, unknown>): void {
  const path = join(home, 'node.yaml');
  const current = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, toYaml({ ...current, ...settings }));
}
