import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ResolveReport, RespondReport, ReviewVerdict, SelfCheck } from '../schemas.js';
import type { AgentBackend, AgentRunOptions, AgentRunResult } from './types.js';

/**
 * Scripted backend used by tests and CI. The script is a JSON file:
 *
 * {
 *   "resolve": {
 *     "<patch subject or *>": {
 *       "status": "resolved" | "skip_patch" | "need_help",
 *       "files": { "<path>": "<content>" | { "action": "delete" | "take_upstream" | "take_patch" } },
 *       "extraFiles": { "<path>": "<content>" },      // written but not reported (tests stray-file gate)
 *       "unreported": true,                            // write files but report none of them
 *       "hook": "<shell command run in cwd>",          // e.g. "git commit -am x" to simulate tampering
 *       "leaveMarkers": true                           // leave a conflict marker in the first file
 *     }
 *   },
 *   "selfcheck": [ SelfCheck, ... ],                   // sequences: last entry repeats
 *   "review":    [ ReviewVerdict, ... ],
 *   "respond":   [ RespondReport & { "files": {...}, "hook": "..." }, ... ],
 *   "invalidJson": { "<schemaName>": <count> },        // return garbage this many times first
 *   "costUsd": 0.5                                      // reported per call
 * }
 */
export interface FakeResolveStep {
  /** Per-attempt overrides; the last entry repeats. Used to test the retry path. */
  attempts?: FakeResolveStep[];
  status?: 'resolved' | 'skip_patch' | 'need_help';
  files?: Record<string, string | { action: 'delete' | 'take_upstream' | 'take_patch' }>;
  extraFiles?: Record<string, string>;
  unreported?: boolean;
  hook?: string;
  leaveMarkers?: boolean;
}

export interface FakeRespondStep extends Partial<RespondReport> {
  files?: Record<string, string | { action: 'delete' }>;
  hook?: string;
}

export interface FakeScript {
  resolve?: Record<string, FakeResolveStep>;
  selfcheck?: Partial<SelfCheck>[];
  review?: (Partial<ReviewVerdict> & { hook?: string })[];
  respond?: FakeRespondStep[];
  invalidJson?: Partial<Record<string, number>>;
  costUsd?: number;
}

export class FakeBackend implements AgentBackend {
  readonly name = 'fake';
  private script: FakeScript | undefined;
  private readonly counters: Record<string, number> = {};
  readonly calls: { schemaName: string; meta: Record<string, string>; prompt: string }[] = [];

  constructor(
    private readonly scriptPath: string | undefined,
    script?: FakeScript,
  ) {
    this.script = script;
  }

  async ensureInstalled(): Promise<void> {}

  private async load(): Promise<FakeScript> {
    if (this.script) return this.script;
    if (!this.scriptPath) throw new Error('fake backend needs fake_script or an inline script');
    this.script = JSON.parse(await fs.readFile(this.scriptPath, 'utf8')) as FakeScript;
    return this.script;
  }

  private next(kind: string): number {
    const n = this.counters[kind] ?? 0;
    this.counters[kind] = n + 1;
    return n;
  }

  async run(prompt: string, opts: AgentRunOptions): Promise<AgentRunResult> {
    const script = await this.load();
    this.calls.push({ schemaName: opts.schemaName, meta: opts.meta, prompt });
    const cost = script.costUsd ?? 0;

    const invalidLeft = script.invalidJson?.[opts.schemaName] ?? 0;
    if (invalidLeft > 0) {
      script.invalidJson = { ...script.invalidJson, [opts.schemaName]: invalidLeft - 1 };
      return { structured: { nonsense: true }, text: 'not valid', costUsd: cost, turns: 1, raw: 'not valid', exitCode: 0 };
    }

    let structured: unknown;
    switch (opts.schemaName) {
      case 'resolve':
        structured = await this.resolve(script, opts);
        break;
      case 'selfcheck': {
        const seq = script.selfcheck ?? [{}];
        const step = seq[Math.min(this.next('selfcheck'), seq.length - 1)] ?? {};
        structured = { complete: true, concerns: [], summary: 'fake self-check', ...step } satisfies SelfCheck;
        break;
      }
      case 'review': {
        const seq = script.review ?? [{}];
        const { hook, ...step } = seq[Math.min(this.next('review'), seq.length - 1)] ?? {};
        if (hook) await this.runHook(hook, opts.cwd);
        structured = {
          verdict: 'approve',
          summary: 'fake review',
          issues: [],
          skips_approved: [],
          checked: { range_diff: true, verify_log: true, commands_run: [] },
          ...step,
        } satisfies ReviewVerdict;
        break;
      }
      case 'respond': {
        const seq = script.respond ?? [{}];
        const step = seq[Math.min(this.next('respond'), seq.length - 1)] ?? {};
        const { files, hook, ...rest } = step;
        const changed = await this.applyFiles(opts.cwd, files ?? {});
        if (hook) await this.runHook(hook, opts.cwd);
        structured = {
          verdict: 'approve',
          responses: [],
          files_changed: changed,
          summary: 'fake response',
          ...rest,
        } satisfies RespondReport;
        break;
      }
    }
    const text = JSON.stringify(structured);
    return { structured, text, costUsd: cost, turns: 1, raw: text, exitCode: 0 };
  }

  private async resolve(script: FakeScript, opts: AgentRunOptions): Promise<ResolveReport> {
    const subject = opts.meta.patchSubject ?? '';
    let step = script.resolve?.[subject] ?? script.resolve?.['*'];
    if (step?.attempts && step.attempts.length > 0) {
      const attempt = Number(opts.meta.attempt ?? '1');
      step = step.attempts[Math.min(attempt - 1, step.attempts.length - 1)];
    }
    if (!step) {
      return {
        status: 'need_help',
        summary: `fake backend has no script for patch "${subject}"`,
        files: [],
        confidence: 'low',
        risks: [],
        notes_for_reviewer: '',
      };
    }
    const files: ResolveReport['files'] = [];
    const conflicted = (opts.meta.conflictedPaths ?? '').split('\n').filter(Boolean);
    for (const [rel, spec] of Object.entries(step.files ?? {})) {
      const abs = path.join(opts.cwd, rel);
      if (typeof spec === 'string') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        let content = spec;
        if (step.leaveMarkers && files.length === 0) content = `<<<<<<< HEAD\n${content}=======\n>>>>>>> patch\n`;
        await fs.writeFile(abs, content);
        files.push({ path: rel, action: conflicted.includes(rel) ? 'edited' : 'created', rationale: 'scripted' });
      } else if (spec.action === 'delete') {
        await fs.rm(abs, { force: true });
        files.push({ path: rel, action: 'deleted', rationale: 'scripted' });
      } else {
        files.push({ path: rel, action: spec.action, rationale: 'scripted' });
      }
    }
    for (const [rel, content] of Object.entries(step.extraFiles ?? {})) {
      const abs = path.join(opts.cwd, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    if (step.hook) await this.runHook(step.hook, opts.cwd);
    return {
      status: step.status ?? 'resolved',
      summary: `scripted resolution for ${subject}`,
      files: step.unreported ? [] : files,
      confidence: 'high',
      risks: [],
      notes_for_reviewer: '',
    };
  }

  private async applyFiles(cwd: string, files: Record<string, string | { action: 'delete' }>): Promise<string[]> {
    const changed: string[] = [];
    for (const [rel, spec] of Object.entries(files)) {
      const abs = path.join(cwd, rel);
      if (typeof spec === 'string') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, spec);
      } else {
        await fs.rm(abs, { force: true });
      }
      changed.push(rel);
    }
    return changed;
  }

  private runHook(cmd: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('sh', ['-c', cmd], { cwd }, (err) => (err ? reject(err) : resolve()));
    });
  }
}
