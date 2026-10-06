import type { AgentRunner } from './agents/runner.js';
import type { RebasePlan } from './plan.js';
import { resolveSystemPrompt, resolveUserPrompt } from './prompts/resolve.js';
import type { ConflictContext, Worker } from './rebase.js';
import type { ResolveReport } from './schemas.js';

/** Adapts an AgentRunner to the rebase engine's Worker interface. */
export function makeWorker(runner: AgentRunner, plan: RebasePlan, cwd: string): Worker {
  return {
    async resolve(ctx: ConflictContext): Promise<ResolveReport> {
      return runner.structured({
        schemaName: 'resolve',
        system: resolveSystemPrompt(),
        user: resolveUserPrompt(ctx, plan),
        cwd,
        mode: 'edit',
        meta: {
          patchSha: ctx.patch.sha,
          patchSubject: ctx.patch.subject,
          conflictedPaths: ctx.paths.map((p) => p.path).join('\n'),
          attempt: String(ctx.attempt),
        },
      });
    },
  };
}
