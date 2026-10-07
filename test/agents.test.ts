import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeBackend, parseClaudeOutput } from '../src/agents/claude.js';
import { CodexBackend, parseCodexOutput } from '../src/agents/codex.js';
import { createBackend } from '../src/agents/index.js';
import type { Inputs } from '../src/inputs.js';
import type { AgentRunOptions } from '../src/agents/types.js';
import { buildChildEnv, forbiddenKeys } from '../src/env.js';
import { silentLogger } from '../src/log.js';
import { resolveReportSchema, reviewVerdictSchema, toJsonSchema } from '../src/schemas.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const bin = path.join(here, 'bin');
const cliOut = path.join(here, 'fixtures', 'cli-output');

function opts(partial: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    cwd: os.tmpdir(),
    model: 'test-model',
    schemaName: 'resolve',
    jsonSchema: toJsonSchema(resolveReportSchema),
    mode: 'edit',
    systemPrompt: 'SYSTEM "quoted" text',
    maxTurns: 7,
    maxBudgetUsd: 2.5,
    timeoutMs: 20_000,
    env: buildChildEnv(),
    transcriptPath: null,
    meta: {},
    ...partial,
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autofork-agents-'));
  process.env.INPUT_TOKEN = 'leak';
  process.env.GITHUB_TOKEN = 'leak';
  process.env.ACTIONS_RUNTIME_TOKEN = 'leak';
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.INPUT_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.ACTIONS_RUNTIME_TOKEN;
});

describe('buildChildEnv', () => {
  it('never passes action or token variables through', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'k', EMPTY: '' });
    expect(forbiddenKeys(env)).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.EMPTY).toBeUndefined();
    expect(env.TERM).toBe('dumb');
    expect(env.CI).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe('toJsonSchema', () => {
  it('produces strict schemas: all properties required, no additional properties', () => {
    const s = toJsonSchema(reviewVerdictSchema) as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean; $schema?: string };
    expect(s.additionalProperties).toBe(false);
    expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
    expect(s.$schema).toBeUndefined();
    const issues = (s.properties.issues as { items: { required: string[]; additionalProperties: boolean } }).items;
    expect(issues.additionalProperties).toBe(false);
    expect(issues.required).toContain('suggested_fix');
  });
});

describe('configured CLI versions', () => {
  it.each(['claude', 'codex'] as const)('accepts a configured preinstalled %s version without installing', async backend => {
    const executable = path.join(tmp, backend);
    await fs.writeFile(executable, `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '${backend} 9.8.7\\n'\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${tmp}:${oldPath}`;
    try {
      const inputs = { claudeVersion: '9.8.7', codexVersion: '9.8.7', sandbox: false } as Inputs;
      const cli = createBackend(backend, inputs, silentLogger);
      await cli.ensureInstalled(false);
      expect(cli.version).toContain('9.8.7');
      const mismatch = createBackend(backend, { ...inputs, claudeVersion: '9.8.6', codexVersion: '9.8.6' }, silentLogger);
      await expect(mismatch.ensureInstalled(false)).rejects.toThrow(/expected.*9\.8\.6/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});

describe('ClaudeBackend', () => {
  it('builds hardened arguments for edit and readonly modes', () => {
    const b = new ClaudeBackend({ log: silentLogger });
    const edit = b.buildArgs(opts());
    expect(edit.slice(0, 2)).toEqual(['--bare', '-p']);
    expect(edit).toContain('--json-schema');
    expect(edit).toContain('dontAsk');
    expect(edit).toContain('--no-session-persistence');
    expect(edit).toContain('--strict-mcp-config');
    expect(edit[edit.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Grep,Glob,Bash');
    expect(edit).toContain('Bash(git diff:*)');
    expect(edit).not.toContain('Bash(git push:*)');
    expect(edit[edit.indexOf('--max-budget-usd') + 1]).toBe('2.50');
    expect(edit[edit.indexOf('--model') + 1]).toBe('test-model');

    const ro = b.buildArgs(opts({ mode: 'readonly' }));
    expect(ro).toContain('--restricted');
    expect(ro[ro.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(ro.join(' ')).not.toContain('Bash');
  });

  it('runs the CLI with the prompt on stdin, a scrubbed environment, and parses the result', async () => {
    const b = new ClaudeBackend({ log: silentLogger, bin: path.join(bin, 'claude') });
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'sk-test', STUB_OUT: tmp, STUB_RESPONSE: path.join(cliOut, 'claude-result.json') });
    const r = await b.run('PROMPT BODY', opts({ env }));
    expect(r.exitCode).toBe(0);
    expect(r.costUsd).toBeCloseTo(0.4321);
    expect(r.turns).toBe(4);
    expect(r.text).toBe('Resolved the conflict.');
    expect(resolveReportSchema.parse(r.structured).status).toBe('resolved');
    expect(await fs.readFile(path.join(tmp, 'stdin'), 'utf8')).toBe('PROMPT BODY');
    const argv = (await fs.readFile(path.join(tmp, 'argv'), 'utf8')).split('\n');
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('SYSTEM "quoted" text');
    const envDump = await fs.readFile(path.join(tmp, 'env'), 'utf8');
    expect(envDump).toContain('ANTHROPIC_API_KEY=sk-test');
    expect(envDump).toContain('DISABLE_AUTOUPDATER=1');
    expect(envDump).toMatch(/CLAUDE_CONFIG_DIR=/);
    expect(envDump).not.toMatch(/^(INPUT_|GITHUB_|ACTIONS_)/m);
  });

  it('refuses to run without an API key', async () => {
    const b = new ClaudeBackend({ log: silentLogger, bin: path.join(bin, 'claude') });
    await expect(b.run('x', opts({ env: buildChildEnv({ STUB_OUT: tmp }) }))).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('parses error results and line-delimited output', () => {
    const r = parseClaudeOutput('{"type":"result","is_error":true,"result":"budget exceeded","total_cost_usd":1}', '', 0);
    expect(r.exitCode).toBe(1);
    expect(r.text).toBe('budget exceeded');
    const multi = parseClaudeOutput('{"type":"system"}\n{"type":"result","result":"ok","structured_output":{"a":1}}', 'warn', 0);
    expect(multi.structured).toEqual({ a: 1 });
    expect(multi.raw).toContain('--- stderr ---');
  });
});

describe('CodexBackend', () => {
  it('builds hardened arguments', () => {
    const b = new CodexBackend({ log: silentLogger });
    const a = b.buildArgs(opts(), '/tmp/schema.json', '/tmp/last.txt');
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a).toContain('--ephemeral');
    expect(a).toContain('--ignore-user-config');
    expect(a).toContain('--ignore-rules');
    expect(a[a.indexOf('--output-schema') + 1]).toBe('/tmp/schema.json');
    expect(a[a.indexOf('-s') + 1]).toBe('workspace-write');
    expect(a).toContain('approval_policy="never"');
    expect(a).toContain('project_doc_max_bytes=0');
    expect(a).toContain('sandbox_workspace_write.network_access=false');
    expect(a.find((x) => x.startsWith('model_instructions='))).toBeUndefined();
    expect(a[a.indexOf('-m') + 1]).toBe('test-model');
    expect(a[a.length - 1]).toBe('-');
    const ro = b.buildArgs(opts({ mode: 'readonly' }), 's', 'l');
    expect(ro[ro.indexOf('-s') + 1]).toBe('read-only');
  });

  it('runs the CLI and reads the last message file', async () => {
    const b = new CodexBackend({ log: silentLogger, bin: path.join(bin, 'codex') });
    const env = buildChildEnv({
      OPENAI_API_KEY: 'sk-oa',
      STUB_OUT: tmp,
      STUB_RESPONSE: path.join(cliOut, 'codex-events.jsonl'),
      STUB_LAST: path.join(cliOut, 'codex-last-message.txt'),
    });
    const r = await b.run('PROMPT', opts({ env, schemaName: 'review', jsonSchema: toJsonSchema(reviewVerdictSchema), mode: 'readonly' }));
    expect(r.exitCode).toBe(0);
    expect(r.costUsd).toBeNull();
    expect(reviewVerdictSchema.parse(r.structured).verdict).toBe('approve');
    const envDump = await fs.readFile(path.join(tmp, 'env'), 'utf8');
    expect(envDump).toContain('CODEX_API_KEY=sk-oa');
    expect(envDump).toMatch(/CODEX_HOME=/);
    expect(envDump).not.toMatch(/^(INPUT_|GITHUB_|ACTIONS_)/m);
    expect(await fs.readFile(path.join(tmp, 'stdin'), 'utf8')).toBe('# Instructions\n\nSYSTEM "quoted" text\n\n# Task\n\nPROMPT');
  });

  it('parses JSONL events without a last-message file', () => {
    const jsonl = ['{"type":"item.completed","item":{"type":"agent_message","text":"{\\"a\\":1}"}}', '{"type":"turn.completed"}'].join('\n');
    const r = parseCodexOutput(jsonl, '', 0, '');
    expect(r.structured).toEqual({ a: 1 });
    expect(r.turns).toBe(1);
    const failed = parseCodexOutput('{"type":"error","message":"boom"}', '', 0, '');
    expect(failed.exitCode).toBe(1);
  });
});
