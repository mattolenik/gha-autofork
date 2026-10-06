import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '../env.js';
import type { Logger } from '../log.js';
import { spawnCollect, which } from './process.js';
import type { AgentBackend, AgentRunOptions, AgentRunResult } from './types.js';
import { sandboxCommand } from '../sandbox.js';

export const CODEX_VERSION = '0.160.0';

export interface CodexBackendOptions {
  bin?: string;
  /** Exact tested version; defaults to CODEX_VERSION. */
  installVersion?: string;
  log: Logger;
  sandbox?: boolean;
}

/**
 * Codex CLI in non-interactive exec mode. The worker runs under the workspace-write sandbox with
 * network disabled; the reviewer under read-only. Project instruction files and user config are
 * ignored, so the only instructions are ours.
 */
export class CodexBackend implements AgentBackend {
  readonly name = 'codex';
  readonly capabilities = { turnLimit: false, budgetLimit: false, costReporting: false };
  version: string | undefined;
  private readonly bin: string;

  constructor(private readonly o: CodexBackendOptions) {
    this.bin = o.bin ?? 'codex';
  }

  async ensureInstalled(install: boolean): Promise<void> {
    const env = buildChildEnv();
    if (await which(this.bin, env)) { await this.checkVersion(env); return; }
    if (!install) throw new Error(`"${this.bin}" is not on PATH and install_clis is false`);
    const spec = `@openai/codex@${this.o.installVersion ?? CODEX_VERSION}`;
    this.o.log.info(`installing ${spec}`);
    const r = await spawnCollect('npm', ['install', '-g', '--no-fund', '--no-audit', spec], {
      cwd: os.tmpdir(),
      env,
      timeoutMs: 5 * 60_000,
      backendName: this.name,
    });
    if (r.code !== 0) throw new Error(`codex install failed: ${r.stderr.trim() || r.stdout.trim()}`);
    if (!(await which(this.bin, env))) throw new Error('codex installed but not found on PATH');
    await this.checkVersion(env);
  }

  private async checkVersion(env: Record<string, string>): Promise<void> {
    const result = await spawnCollect(this.bin, ['--version'], { cwd: os.tmpdir(), env, timeoutMs: 10_000, backendName: this.name });
    this.version = result.stdout.trim();
    const expected = this.o.installVersion ?? CODEX_VERSION;
    if (result.code !== 0 || this.version.match(/\d+\.\d+\.\d+/)?.[0] !== expected) throw new Error(`expected Codex ${expected}, found ${this.version}`);
  }

  buildArgs(opts: AgentRunOptions, schemaFile: string, lastMessageFile: string): string[] {
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--output-schema',
      schemaFile,
      '--output-last-message',
      lastMessageFile,
      '-C',
      opts.cwd,
      '-s',
      opts.mode === 'edit' ? 'workspace-write' : 'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'sandbox_workspace_write.network_access=false',
    ];
    if (opts.model) args.push('-m', opts.model);
    args.push('-');
    return args;
  }

  async run(prompt: string, opts: AgentRunOptions): Promise<AgentRunResult> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-codex-'));
    try {
      const schemaFile = path.join(tmp, 'schema.json');
      const lastMessageFile = path.join(tmp, 'last-message.txt');
      const codexHome = path.join(tmp, 'home');
      await fs.mkdir(codexHome);
      await fs.writeFile(schemaFile, JSON.stringify(opts.jsonSchema));
      const apiKey = opts.env.CODEX_API_KEY ?? opts.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('codex backend needs OPENAI_API_KEY (openai_api_key input)');
      const env = { ...opts.env, CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey, CODEX_HOME: codexHome };
      // codex exec has no system-prompt flag (model_instructions is not a recognized key in 0.160), so the
      // instructions travel at the top of the prompt. AGENTS.md discovery is disabled, so they are the only ones.
      const args = this.buildArgs(opts, schemaFile, lastMessageFile);
      const launch = this.o.sandbox ? await sandboxCommand(this.bin, args, opts.cwd, opts.mode, env, [tmp]) : { bin: this.bin, args, env };
      const r = await spawnCollect(launch.bin, launch.args, {
        cwd: opts.cwd,
        env: launch.env,
        stdin: composePrompt(opts.systemPrompt, prompt),
        timeoutMs: opts.timeoutMs,
        backendName: this.name,
        streamTo: opts.transcriptPath,
      });
      const lastMessage = await fs.readFile(lastMessageFile, 'utf8').catch(() => '');
      return parseCodexOutput(r.stdout, r.stderr, r.code, lastMessage);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

export function composePrompt(systemPrompt: string, prompt: string): string {
  return `# Instructions\n\n${systemPrompt}\n\n# Task\n\n${prompt}`;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string };
  message?: string;
}

export function parseCodexOutput(stdout: string, stderr: string, code: number, lastMessage: string): AgentRunResult {
  let text = lastMessage.trim();
  let turns = 0;
  let sawError = false;
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(l) as CodexEvent;
    } catch {
      continue;
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      turns += 1;
      if (!lastMessage.trim() && ev.item.text) text = ev.item.text.trim();
    }
    if (ev.type === 'error' || ev.type === 'turn.failed') sawError = true;
  }
  let structured: unknown;
  if (text) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }
  }
  return {
    structured,
    text,
    // Codex reports token usage but not dollars; the orchestrator's time limit is the backstop.
    costUsd: null,
    turns: turns || null,
    raw: stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout,
    exitCode: sawError ? Math.max(code, 1) : code,
  };
}
