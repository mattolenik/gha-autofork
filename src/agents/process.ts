import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { AgentTimeoutError } from './runner.js';

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  backendName: string;
  /** Stream combined output here as it arrives (transcript). */
  streamTo?: string | null;
}

/**
 * Spawn a CLI in its own process group, feed it stdin, collect output, and kill the whole group on
 * timeout. Agents spawn their own children (shell, git); a plain child.kill would orphan them.
 */
export async function spawnCollect(bin: string, args: string[], o: SpawnOptions): Promise<SpawnResult> {
  const sink = o.streamTo ? await fs.open(o.streamTo, 'a') : null;
  try {
    return await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => {
        out.push(b);
        void sink?.write(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        err.push(b);
        void sink?.write(b);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, o.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new AgentTimeoutError(o.backendName, o.timeoutMs));
          return;
        }
        resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
      if (o.stdin !== undefined) child.stdin.end(o.stdin);
      else child.stdin.end();
    });
  } finally {
    await sink?.close();
  }
}

export async function which(bin: string, env: Record<string, string>): Promise<string | undefined> {
  const r = await spawnCollect('sh', ['-c', `command -v ${bin}`], { cwd: process.cwd(), env, timeoutMs: 10_000, backendName: 'which' }).catch(() => null);
  if (!r || r.code !== 0) return undefined;
  return r.stdout.trim() || undefined;
}
