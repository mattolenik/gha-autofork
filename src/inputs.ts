import * as core from '@actions/core';
import { z } from 'zod';

export const BACKENDS = ['deepseek', 'claude', 'codex', 'fake'] as const;
export type BackendName = (typeof BACKENDS)[number];
/** Default for both roles: Claude Code against DeepSeek's Anthropic-compatible endpoint. */
export const DEFAULT_AGENT = 'deepseek:deepseek-flash[1m]';

export interface AgentSpec {
  backend: BackendName;
  model: string;
}

const agentSpecSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const idx = raw.indexOf(':');
    const backend = (idx === -1 ? raw : raw.slice(0, idx)).trim();
    const model = idx === -1 ? '' : raw.slice(idx + 1).trim();
    if (!(BACKENDS as readonly string[]).includes(backend)) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown backend "${backend}" (expected one of ${BACKENDS.join(', ')})`,
      });
      return z.NEVER;
    }
    if (backend !== 'fake' && model === '') {
      ctx.addIssue({ code: 'custom', message: `backend "${backend}" requires a model, e.g. ${backend}:<model>` });
      return z.NEVER;
    }
    return { backend: backend as BackendName, model } satisfies AgentSpec;
  });

const boolString = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', '']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const intString = (min: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(min));

const numString = (min: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'must be a number')
    .transform(Number)
    .pipe(z.number().min(min));

const optionalString = z.string().trim().transform((s) => (s === '' ? undefined : s));
const cliVersion = optionalString.pipe(z.string().regex(/^\d+\.\d+\.\d+$/, 'must be an exact CLI version').optional()).optional();

export const inputsSchema = z.object({
  upstream: z.string().trim().min(1, 'upstream is required'),
  upstreamBranch: optionalString,
  branch: optionalString,
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'repository must be owner/repo'),
  token: z.string().min(1, 'token is required'),
  worker: agentSpecSchema,
  reviewer: z
    .string()
    .trim()
    .transform((s) => (s === '' || s === 'none' ? undefined : s))
    .pipe(agentSpecSchema.optional()),
  maxRounds: intString(1),
  verifyCommand: optionalString,
  maxPatches: intString(1),
  maxCostUsd: numString(0),
  maxTurns: intString(1),
  agentTimeoutMinutes: numString(0.1),
  keepBackups: intString(0),
  publish: z.enum(['auto', 'stage']),
  installClis: boolString,
  dryRun: boolString,
  deepseekApiKey: optionalString.optional(),
  anthropicApiKey: optionalString,
  openaiApiKey: optionalString,
  forkRemoteUrl: optionalString,
  fakeScript: optionalString,
  phase: z.enum(['prepare', 'verify', 'publish', 'report']).optional(),
  artifactDir: optionalString.optional(),
  candidateDigest: optionalString.optional(),
  verificationDir: optionalString.optional(),
  verificationDigest: optionalString.optional(),
  upstreamToken: optionalString.optional(),
  initialBase: optionalString.optional(),
  sandbox: boolString.optional(),
  verifySandbox: boolString.optional(),
  forkNotes: boolString.optional(),
  requireHardLimits: boolString.optional(),
  resultsDigest: optionalString.optional(),
  claudeVersion: cliVersion,
  codexVersion: cliVersion,
  rescueBranch: optionalString.optional(),
});

export type Inputs = z.infer<typeof inputsSchema>;

/** Raw string map, keyed by the camelCase names above. Exposed for tests. */
export type RawInputs = { [K in keyof Inputs]?: string };

const INPUT_NAMES: { [K in keyof Inputs]-?: string } = {
  upstream: 'upstream',
  upstreamBranch: 'upstream_branch',
  branch: 'branch',
  repository: 'repository',
  token: 'token',
  worker: 'worker',
  reviewer: 'reviewer',
  maxRounds: 'max_rounds',
  verifyCommand: 'verify_command',
  maxPatches: 'max_patches',
  maxCostUsd: 'max_cost_usd',
  maxTurns: 'max_turns',
  agentTimeoutMinutes: 'agent_timeout_minutes',
  keepBackups: 'keep_backups',
  publish: 'publish',
  installClis: 'install_clis',
  dryRun: 'dry_run',
  deepseekApiKey: 'deepseek_api_key',
  anthropicApiKey: 'anthropic_api_key',
  openaiApiKey: 'openai_api_key',
  forkRemoteUrl: 'fork_remote_url',
  fakeScript: 'fake_script',
  phase: 'phase',
  artifactDir: 'artifact_dir',
  candidateDigest: 'candidate_digest',
  verificationDir: 'verification_dir',
  verificationDigest: 'verification_digest',
  upstreamToken: 'upstream_token',
  initialBase: 'initial_base',
  sandbox: 'sandbox',
  verifySandbox: 'verify_sandbox',
  forkNotes: 'fork_notes',
  requireHardLimits: 'require_hard_limits',
  resultsDigest: 'results_digest',
  claudeVersion: 'claude_version',
  codexVersion: 'codex_version',
  rescueBranch: 'rescue_branch',
};

export function readRawInputs(): RawInputs {
  const out = {} as RawInputs;
  for (const key of Object.keys(INPUT_NAMES) as (keyof Inputs)[]) {
    out[key] = core.getInput(INPUT_NAMES[key]);
  }
  if (!out.phase) out.phase = 'prepare';
  if (!out.worker) out.worker = out.phase === 'prepare' ? DEFAULT_AGENT : 'fake';
  return out;
}

export function parseInputs(raw: RawInputs): Inputs {
  const result = inputsSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const key = i.path[0] as keyof Inputs | undefined;
      const name = key ? INPUT_NAMES[key] : '(root)';
      return `  ${name}: ${i.message}`;
    });
    throw new Error(`invalid inputs:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function describeAgent(spec: AgentSpec): string {
  return spec.model ? `${spec.backend}:${spec.model}` : spec.backend;
}
