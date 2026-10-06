import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spawnCollect } from '../src/agents/process.js';
import { buildChildEnv } from '../src/env.js';
import { sandboxCommand } from '../src/sandbox.js';
import { createFixture, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });

it.skipIf(process.platform !== 'linux')('isolates Git metadata, readonly files, runner home, and the parent process namespace', async () => {
  fx = await createFixture();
  const worktree = path.join(fx.root, 'wt');
  await fx.fork.worktreeAdd(worktree, 'HEAD');
  const common = await fx.fork.commonDir();
  const script = `test ! -e /proc/${process.pid}/environ && git rev-parse HEAD >/dev/null && ! echo corrupt > '${common}/config' && ! echo corrupt > .git && echo ok > permitted.txt`;
  const launch = await sandboxCommand('sh', ['-c', script], worktree, 'edit', buildChildEnv());
  const result = await spawnCollect(launch.bin, launch.args, { cwd: worktree, env: launch.env, timeoutMs: 10000, backendName: 'sandbox-test' });
  expect(result.code, result.stderr).toBe(0);
  expect(await fs.readFile(path.join(worktree, 'permitted.txt'), 'utf8')).toBe('ok\n');
  const readOnly = await sandboxCommand('sh', ['-c', '! echo corrupt >> README.md'], worktree, 'readonly', buildChildEnv());
  const ro = await spawnCollect(readOnly.bin, readOnly.args, { cwd: worktree, env: readOnly.env, timeoutMs: 10000, backendName: 'sandbox-test' });
  expect(ro.code, ro.stderr).toBe(0);
});
