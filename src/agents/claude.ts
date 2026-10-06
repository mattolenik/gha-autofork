import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '../env.js';
import type { Logger } from '../log.js';
import { spawnCollect, which } from './process.js';
import type { AgentBackend, AgentRunOptions, AgentRunResult } from './types.js';

/** Read-only git subcommands the worker may run. */
export const READ_ONLY_GIT = ['diff', 'show', 'log', 'blame', 'grep', 'ls-files', 'status', 'rev-parse', 'cat-file', 'range-diff'] as const;

export const CLAUDE_INSTALL_URL = 'https://claude.ai/install.sh';

export interface ClaudeBackendOptions {
  bin?: string;
  /** Pin a version for the installer; default "stable". */
  installVersion?: string;
  log: Logger;
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
  private bin: string;

  constructor(private readonly o: ClaudeBackendOptions) {
    this.bin = o.bin ?? 'claude';
  }

  async ensureInstalled(install: boolean): Promise<void> {
    const env = buildChildEnv();
    if (await which(this.bin, env)) return;
    if (!install) throw new Error(`"${this.bin}" is not on PATH and install_clis is false`);
    this.o.log.info(`installing Claude Code (${this.o.installVersion ?? 'stable'})`);
    const r = await spawnCollect('sh', ['-c', `curl -fsSL ${CLAUDE_INSTALL_URL} | bash -s ${this.o.installVersion ?? 'stable'}`], {
      cwd: os.tmpdir(),
      env,
      timeoutMs: 5 * 60_000,
      backendName: this.name,
    });
    if (r.code !== 0) throw new Error(`Claude Code install failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const local = path.join(env.HOME ?? os.homedir(), '.local', 'bin', 'claude');
    if (await which(this.bin, env)) return;
    try {
      await fs.access(local);
      this.bin = local;
    } catch {
      throw new Error('Claude Code installed but the "claude" binary was not found on PATH or in ~/.local/bin');
    }
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
      const r = await spawnCollect(this.bin, this.buildArgs(opts), {
        cwd: opts.cwd,
        env,
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
