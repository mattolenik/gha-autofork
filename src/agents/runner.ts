import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { z } from 'zod';
import type { Budget } from '../budget.js';
import { AutoforkError } from '../errors.js';
import type { Logger } from '../log.js';
import { SCHEMAS, toJsonSchema, type SchemaName } from '../schemas.js';
import type { AgentBackend, AgentMode, AgentRunResult } from './types.js';

export class AgentTimeoutError extends Error {
  constructor(readonly backend: string, readonly timeoutMs: number) {
    super(`${backend} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'AgentTimeoutError';
  }
}

export interface AgentRunnerOptions {
  backend: AgentBackend;
  model: string;
  role: 'worker' | 'reviewer';
  budget: Budget;
  maxTurns: number;
  timeoutMs: number;
  env: Record<string, string>;
  transcriptsDir: string | null;
  log: Logger;
}

export interface StructuredCall {
  schemaName: SchemaName;
  system: string;
  user: string;
  cwd: string;
  mode: AgentMode;
  meta?: Record<string, string>;
}

/**
 * Runs one agent with budget tracking, transcript capture, schema validation, and a single retry
 * that quotes the validation error back to the agent.
 */
export class AgentRunner {
  private seq = 0;
  readonly backendName: string;

  constructor(private readonly o: AgentRunnerOptions) {
    this.backendName = o.backend.name;
  }

  get label(): string {
    return this.o.model ? `${this.o.backend.name}:${this.o.model}` : this.o.backend.name;
  }

  async structured<N extends SchemaName>(call: StructuredCall & { schemaName: N }): Promise<z.infer<(typeof SCHEMAS)[N]>> {
    const schema = SCHEMAS[call.schemaName];
    const jsonSchema = toJsonSchema(schema);
    let user = call.user;
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.invoke(call, user, jsonSchema, attempt);
      const parsed = schema.safeParse(result.structured ?? tryParseJson(result.text));
      if (parsed.success) return parsed.data as z.infer<(typeof SCHEMAS)[N]>;
      lastError = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      this.o.log.warning(`${this.o.role} (${this.label}) returned output that does not match the ${call.schemaName} schema: ${lastError}`);
      user = `${call.user}\n\n## Correction\n\nYour previous answer did not match the required JSON schema: ${lastError}\nAnswer again with a single JSON object that matches the schema exactly.`;
    }
    throw new AutoforkError('FAILED_AGENT', `${this.o.role} (${this.label}) failed to produce valid ${call.schemaName} output twice: ${lastError}`);
  }

  private async invoke(call: StructuredCall, user: string, jsonSchema: Record<string, unknown>, attempt: number): Promise<AgentRunResult> {
    this.o.budget.assertAvailable();
    this.seq += 1;
    const id = `${String(this.seq).padStart(3, '0')}-${this.o.role}-${call.schemaName}${attempt > 1 ? `-retry${attempt}` : ''}`;
    this.o.log.info(`${this.o.role} (${this.label}): ${call.schemaName}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    const transcriptPath = this.o.transcriptsDir ? path.join(this.o.transcriptsDir, `${id}.log`) : null;
    if (this.o.transcriptsDir) await fs.mkdir(this.o.transcriptsDir, { recursive: true });
    const started = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.o.backend.run(user, {
        cwd: call.cwd,
        model: this.o.model,
        schemaName: call.schemaName,
        jsonSchema,
        mode: call.mode,
        systemPrompt: call.system,
        maxTurns: this.o.maxTurns,
        maxBudgetUsd: Math.max(0, this.o.budget.maxUsd - this.o.budget.spentUsd) || null,
        timeoutMs: this.o.timeoutMs,
        env: this.o.env,
        transcriptPath,
        meta: call.meta ?? {},
      });
    } catch (err) {
      this.o.budget.record(null); // a killed/crashed CLI may have incurred unreported spend
      if (err instanceof AgentTimeoutError) {
        throw new AutoforkError('FAILED_TIMEOUT', `${this.o.role} (${this.label}) ${err.message}`);
      }
      throw new AutoforkError('FAILED_AGENT', `${this.o.role} (${this.label}) crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    this.o.log.info(
      `${this.o.role} (${this.label}): done in ${seconds}s, exit ${result.exitCode}, cost ${result.costUsd === null ? 'n/a' : `$${result.costUsd.toFixed(3)}`}`,
    );
    if (transcriptPath) {
      const header = [`# ${id}`, `backend: ${this.label}`, `cwd: ${call.cwd}`, `exit: ${result.exitCode}`, `cost_usd: ${result.costUsd ?? 'n/a'}`, '', '## system', '', call.system, '', '## user', '', user, '', '## raw output', ''].join('\n');
      await fs.writeFile(transcriptPath, `${header}\n${result.raw}\n`);
    }
    this.o.budget.record(result.costUsd);
    if (result.exitCode !== 0) {
      throw new AutoforkError('FAILED_AGENT', `${this.o.role} (${this.label}) exited with code ${result.exitCode}: ${tail(result.raw, 2000)}`);
    }
    return result;
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}
