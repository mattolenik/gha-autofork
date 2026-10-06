import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Git } from './git.js';
import { which } from './agents/process.js';

export interface SandboxedCommand { bin: string; args: string[]; env: Record<string, string> }

/** Linux process/filesystem boundary. Parent processes, home directories and runner IPC are hidden. */
export async function sandboxCommand(bin: string, args: string[], cwd: string, mode: 'edit' | 'readonly',
  env: Record<string, string>, writable: string[] = []): Promise<SandboxedCommand> {
  if (process.platform !== 'linux') throw new Error('sandbox=true requires Linux with bubblewrap; use sandbox=false only for trusted local testing');
  const bwrap = await which('bwrap', env);
  if (!bwrap) throw new Error('bubblewrap is required: install it before running the action');
  const executable = await which(bin, env);
  if (!executable) throw new Error(`executable not found: ${bin}`);
  const realBin = await fs.realpath(executable);
  const git = new Git(cwd);
  const common = await git.commonDir();
  const gitFile = path.join(cwd, '.git');
  const home = '/tmp/autopatch-home';
  const sandboxArgs = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/root',
    '--dir', home, mode === 'edit' ? '--bind' : '--ro-bind', cwd, cwd,
    '--ro-bind', common, common];
  if (gitFile !== common) sandboxArgs.push('--ro-bind', gitFile, gitFile);
  // Native Claude installations can live in the hidden home directory.
  if (realBin.startsWith('/home/') || realBin.startsWith('/root/') || realBin.startsWith('/tmp/')) {
    sandboxArgs.push('--ro-bind', path.dirname(realBin), path.dirname(realBin));
  }
  for (const dir of writable) sandboxArgs.push('--bind', dir, dir);
  sandboxArgs.push('--chdir', cwd, '--', realBin, ...args);
  return { bin: bwrap, args: sandboxArgs, env: { ...env, HOME: home, TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } };
}
