import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../src/agents/claude.js';
import { CodexBackend } from '../src/agents/codex.js';
import { AgentRunner } from '../src/agents/runner.js';
import { Budget } from '../src/budget.js';
import { Git } from '../src/git.js';
import { buildChildEnv } from '../src/env.js';
import { silentLogger } from '../src/log.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-cli-smoke-'));
try {
  const git = new Git(root);
  await git.run(['init', '-q']);
  await fs.writeFile(path.join(root, 'fixture.txt'), 'smoke test\n');
  await git.run(['add', '--', 'fixture.txt']);
  await git.run(['commit', '-qm', 'fixture']);
  const backends = [new ClaudeBackend({ log: silentLogger, sandbox: true }), new CodexBackend({ log: silentLogger, sandbox: true })];
  for (const backend of backends) {
    await backend.ensureInstalled(true);
    console.log(`${backend.name}: ${backend.version}`);
    if (process.env.LIVE_MODELS !== 'true') continue;
    const model = process.env[backend.name === 'claude' ? 'CLAUDE_MODEL' : 'CODEX_MODEL'];
    if (!model) throw new Error('live smoke requires CLAUDE_MODEL and CODEX_MODEL');
    const runner = new AgentRunner({ backend, model, role: 'reviewer', budget: new Budget(2), maxTurns: 5, timeoutMs: 120000,
      env: buildChildEnv(backend.name === 'claude' ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      transcriptsDir: null, log: silentLogger });
    const result = await runner.structured({ schemaName: 'selfcheck', mode: 'readonly', cwd: root,
      system: 'Read fixture.txt. Return the required JSON with complete=true and no concerns only if the file says smoke test.', user: 'Check the fixture.' });
    assert.equal(result.complete, true);
    assert.equal(result.concerns.length, 0);
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
