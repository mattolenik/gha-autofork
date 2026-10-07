import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Git } from '../src/git.js';
import { sandboxCommand } from '../src/sandbox.js';
import { buildChildEnv } from '../src/env.js';
import { spawnCollect } from '../src/agents/process.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autofork-dns-'));
try {
  const git = new Git(root);
  await git.run(['init', '-q']);
  await git.run(['commit', '--allow-empty', '-qm', 'sandbox smoke']);
  console.log(`Host resolver: ${await fs.realpath('/etc/resolv.conf')}`);
  const script = 'const dns = require("node:dns").promises; Promise.all(["api.anthropic.com", "api.openai.com"].map(h => dns.lookup(h).then(() => console.log(h + ": DNS OK")))).catch(e => { console.error(e); process.exit(1); });';
  const launch = await sandboxCommand(process.execPath, ['-e', script], root, 'readonly', buildChildEnv());
  const result = await spawnCollect(launch.bin, launch.args, { cwd: root, env: launch.env, timeoutMs: 30000, backendName: 'DNS smoke' });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  console.log(result.stdout.trim());
} finally { await fs.rm(root, { recursive: true, force: true }); }
