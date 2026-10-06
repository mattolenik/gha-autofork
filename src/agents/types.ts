import type { SchemaName } from '../schemas.js';

export type AgentMode = 'edit' | 'readonly';

export interface AgentRunOptions {
  /** Working directory the agent operates in (the rebase worktree). */
  cwd: string;
  model: string;
  /** Which structured output is expected; the JSON Schema is derived from it. */
  schemaName: SchemaName;
  jsonSchema: Record<string, unknown>;
  mode: AgentMode;
  systemPrompt: string;
  maxTurns: number;
  /** Per-invocation budget hint for backends that support one. */
  maxBudgetUsd: number | null;
  timeoutMs: number;
  /** Extra environment the backend needs (API key). Already scrubbed by the caller. */
  env: Record<string, string>;
  /** File to append the raw transcript to. */
  transcriptPath: string | null;
  /** Free-form metadata for backends that need it (the fake backend keys scripts off it). */
  meta: Record<string, string>;
}

export interface AgentRunResult {
  /** Parsed structured output, or undefined if the backend produced none. */
  structured: unknown;
  /** Final assistant text. */
  text: string;
  costUsd: number | null;
  turns: number | null;
  /** Raw stdout for the transcript. */
  raw: string;
  exitCode: number;
}

export interface AgentBackend {
  readonly name: string;
  readonly capabilities?: { turnLimit: boolean; budgetLimit: boolean; costReporting: boolean };
  version?: string | undefined;
  /** Make sure the CLI is available; may install it. */
  ensureInstalled(install: boolean): Promise<void>;
  run(prompt: string, opts: AgentRunOptions): Promise<AgentRunResult>;
}
