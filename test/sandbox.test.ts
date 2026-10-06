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

it.skipIf(process.platform !== 'linux')('preserves a systemd-resolved target behind an /etc/resolv.conf symlink', async () => {
  fx = await createFixture();
  const resolver = path.join(fx.root, 'resolver');
  const etc = path.join(fx.root, 'etc');
  await fs.mkdir(resolver);
  await fs.mkdir(etc);
  await fs.writeFile(path.join(resolver, 'stub-resolv.conf'), 'nameserver 127.0.0.53\n');
  await fs.symlink('/run/systemd/resolve/stub-resolv.conf', path.join(etc, 'resolv.conf'));
  const launch = await sandboxCommand('sh', ['-c', 'cat /etc/resolv.conf'], fx.fork.cwd, 'readonly', buildChildEnv());
  // Substitute a synthetic host resolver directory; the production mount destination/order stays intact.
  const resolverMount = launch.args.indexOf('--ro-bind-try');
  expect(resolverMount).toBeGreaterThan(0);
  launch.args[resolverMount + 1] = resolver;
  launch.args.splice(launch.args.indexOf('--'), 0, '--ro-bind', etc, '/etc');
  const result = await spawnCollect(launch.bin, launch.args, { cwd: fx.fork.cwd, env: launch.env, timeoutMs: 10000, backendName: 'resolver-test' });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('nameserver 127.0.0.53\n');
});
