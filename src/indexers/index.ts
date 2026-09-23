import type { RepositoryRow } from '../registry.ts';
import type { Ctx } from '../types.ts';
import { indexRepository, type RepositoryIndexReport } from './repository.ts';
import { indexTasks, type TaskIndexReport } from './tasks.ts';

export interface IndexReport {
  started_at: string;
  finished_at: string;
  repositories: RepositoryIndexReport[];
  tasks: TaskIndexReport[];
}

/** Indexes repositories first so task claims can be matched against freshly indexed contracts. */
export async function indexAll(ctx: Ctx, fetchImpl: typeof fetch = fetch): Promise<IndexReport> {
  const started = ctx.now().toISOString();
  const repositories: RepositoryIndexReport[] = [];
  for (const repo of ctx.db.all<RepositoryRow>('SELECT * FROM repositories ORDER BY id')) {
    repositories.push(await indexRepository(ctx, repo));
  }
  const tasks = await indexTasks(ctx, fetchImpl);
  for (const r of repositories) {
    const endpoints = r.components.reduce((n, c) => n + c.endpoints, 0);
    const warnings = r.components.flatMap((c) => c.warnings);
    ctx.log(
      r.error
        ? `index: ${r.repository} failed: ${r.error}`
        : `index: ${r.repository}@${r.commit?.slice(0, 8) ?? 'workdir'} → ${endpoints} endpoint(s), ${r.codeowners_rules} CODEOWNERS rule(s)` +
            `${r.conflicts.length ? `, conflicts ${r.conflicts.join(', ')}` : ''}${warnings.length ? `; warnings: ${warnings.join('; ')}` : ''}`,
    );
  }
  for (const t of tasks) {
    ctx.log(t.error ? `index: tasks ${t.source} failed: ${t.error}` : `index: ${t.tasks} task(s) from ${t.source}${t.conflicts.length ? `, conflicts ${t.conflicts.join(', ')}` : ''}`);
  }
  return { started_at: started, finished_at: ctx.now().toISOString(), repositories, tasks };
}
