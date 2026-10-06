import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '../env.js';
import type { Logger } from '../log.js';
import { spawnCollect, which } from './process.js';
import type { AgentBackend, AgentRunOptions, AgentRunResult } from './types.js';
import { sandboxCommand } from '../sandbox.js';

/** Read-only git subcommands the worker may run. */
export const READ_ONLY_GIT = ['diff', 'show', 'log', 'blame', 'grep', 'ls-files', 'status', 'rev-parse', 'cat-file', 'range-diff'] as const;

export const CLAUDE_INSTALL_URL = 'https://claude.ai/install.sh';
export const CLAUDE_VERSION = '2.1.288';

export interface ClaudeBackendOptions {
  bin?: string;
  /** Exact tested version; defaults to CLAUDE_VERSION. */
  installVersion?: string;
  log: Logger;
  sandbox?: boolean;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
}

/**
 * Claude Code in bare print mode. `--bare` disables CLAUDE.md discovery, hooks, plugins, MCP and the
 * keychain, so the only authentication is ANTHROPIC_API_KEY and the only instructions are ours.
 */
export class ClaudeBackend implements AgentBackend {
  readonly name = 'claude';
  readonly capabilities = { turnLimit: true, budgetLimit: true, costReporting: true };
  version: string | undefined;
  private bin: string;

  constructor(private readonly o: ClaudeBackendOptions) {
    this.bin = o.bin ?? 'claude';
  }

  async ensureInstalled(install: boolean): Promise<void> {
    const env = buildChildEnv();
    if (await which(this.bin, env)) { await this.checkVersion(env); return; }
    if (!install) throw new Error(`"${this.bin}" is not on PATH and install_clis is false`);
    const version = this.o.installVersion ?? CLAUDE_VERSION;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Claude version must be an exact semver');
    this.o.log.info(`installing Claude Code (${version})`);
    const r = await spawnCollect('bash', ['-o', 'pipefail', '-c', 'curl -fsSL "$1" | bash -s "$2"', 'bash', CLAUDE_INSTALL_URL, version], {
      cwd: os.tmpdir(),
      env,
      timeoutMs: 5 * 60_000,
      backendName: this.name,
    });
    if (r.code !== 0) throw new Error(`Claude Code install failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const local = path.join(env.HOME ?? os.homedir(), '.local', 'bin', 'claude');
    if (await which(this.bin, env)) { await this.checkVersion(env); return; }
    try {
      await fs.access(local);
      this.bin = local;
    } catch {
      throw new Error('Claude Code installed but the "claude" binary was not found on PATH or in ~/.local/bin');
    }
    await this.checkVersion(env);
  }

  private async checkVersion(env: Record<string, string>): Promise<void> {
    const result = await spawnCollect(this.bin, ['--version'], { cwd: os.tmpdir(), env, timeoutMs: 10_000, backendName: this.name });
    this.version = result.stdout.trim();
    const expected = this.o.installVersion ?? CLAUDE_VERSION;
    if (result.code !== 0 || this.version.match(/\d+\.\d+\.\d+/)?.[0] !== expected) throw new Error(`expected Claude Code ${expected}, found ${this.version}`);
  }

  buildArgs(opts: AgentRunOptions): string[] {
    const args = [
      '--bare',
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(opts.jsonSchema),
      '--system-prompt',
      opts.systemPrompt,
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources',
      'user',
      '--max-turns',
      String(opts.maxTurns),
      '--disallowedTools',
      'WebFetch,WebSearch,Task,NotebookEdit',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.maxBudgetUsd !== null && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', opts.maxBudgetUsd.toFixed(2));
    if (opts.mode === 'edit') {
      args.push('--tools', 'Read,Edit,Write,Grep,Glob,Bash');
      args.push('--allowedTools', 'Read', 'Edit', 'Write', 'Grep', 'Glob', ...READ_ONLY_GIT.map((s) => `Bash(git ${s}:*)`));
    } else {
      args.push('--restricted', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read', 'Grep', 'Glob');
    }
    return args;
  }

  async run(prompt: string, opts: AgentRunOptions): Promise<AgentRunResult> {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-claude-'));
    try {
      const env: Record<string, string> = {
        ...opts.env,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CONFIG_DIR: configDir,
      };
      if (!env.ANTHROPIC_API_KEY) throw new Error('claude backend needs ANTHROPIC_API_KEY (anthropic_api_key input)');
      const args = this.buildArgs(opts);
      const launch = this.o.sandbox ? await sandboxCommand(this.bin, args, opts.cwd, opts.mode, env, [configDir]) : { bin: this.bin, args, env };
      const r = await spawnCollect(launch.bin, launch.args, {
        cwd: opts.cwd,
        env: launch.env,
        stdin: prompt,
        timeoutMs: opts.timeoutMs,
        backendName: this.name,
        streamTo: opts.transcriptPath,
      });
      return parseClaudeOutput(r.stdout, r.stderr, r.code);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  }
}

export function parseClaudeOutput(stdout: string, stderr: string, code: number): AgentRunResult {
  let parsed: ClaudeJsonResult | undefined;
  const trimmed = stdout.trim();
  try {
    parsed = JSON.parse(trimmed) as ClaudeJsonResult;
  } catch {
    // Some versions emit one JSON object per line; take the last result object.
    for (const line of trimmed.split('\n').reverse()) {
      try {
        const obj = JSON.parse(line) as ClaudeJsonResult;
        if (obj && obj.type === 'result') {
          parsed = obj;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return {
    structured: parsed?.structured_output,
    text: parsed?.result ?? '',
    costUsd: typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    turns: typeof parsed?.num_turns === 'number' ? parsed.num_turns : null,
    raw: stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout,
    exitCode: parsed?.is_error ? Math.max(code, 1) : code,
  };
}
