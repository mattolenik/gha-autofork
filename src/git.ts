import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Extra environment on top of the base environment. */
  env?: Record<string, string>;
  /** Replace the working directory for this call. */
  cwd?: string;
  /** Allow non-zero exit codes; default throws. */
  allowFailure?: boolean;
  /** Data for stdin. */
  input?: string;
  /** Abort after this many milliseconds. */
  timeoutMs?: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
  }
}

/** Environment every git call gets. Prevents editors, hooks, prompts, and user config from interfering. */
export const BASE_GIT_ENV: Record<string, string> = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export const BOT_IDENTITY = {
  name: 'autopatch[bot]',
  email: 'autopatch@users.noreply.github.com',
};

export interface GitOptions {
  /** Additional -c key=value config applied to every invocation. */
  config?: Record<string, string>;
  /** Base environment; defaults to a minimal allowlist from process.env. */
  env?: Record<string, string>;
}

function baseEnvFromProcess(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Thin wrapper over the git CLI bound to a working directory. */
export class Git {
  readonly cwd: string;
  private readonly config: Record<string, string>;
  private readonly env: Record<string, string>;

  constructor(cwd: string, options: GitOptions = {}) {
    this.cwd = cwd;
    this.config = {
      'user.name': BOT_IDENTITY.name,
      'user.email': BOT_IDENTITY.email,
      'commit.gpgsign': 'false',
      'tag.gpgsign': 'false',
      'core.hooksPath': '/dev/null',
      'advice.detachedHead': 'false',
      'advice.skippedCherryPicks': 'false',
      'advice.mergeConflict': 'false',
      'core.autocrlf': 'false',
      'color.ui': 'never',
      'maintenance.auto': 'false',
      'gc.auto': '0',
      'core.fsmonitor': 'false',
      'protocol.ext.allow': 'never',
      ...options.config,
    };
    this.env = { ...baseEnvFromProcess(), ...BASE_GIT_ENV, ...options.env };
  }

  /** A Git bound to another directory with the same config and env. */
  at(cwd: string): Git {
    return new Git(cwd, { config: this.config, env: this.env });
  }

  withConfig(config: Record<string, string>): Git {
    return new Git(this.cwd, { config: { ...this.config, ...config }, env: this.env });
  }

  async run(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const configArgs: string[] = [];
    for (const [k, v] of Object.entries(this.config)) configArgs.push('-c', `${k}=${v}`);
    const commandArgs = ['diff', 'show', 'log', 'range-diff'].includes(args[0] ?? '')
      ? [args[0]!, '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
    const fullArgs = [...configArgs, ...commandArgs];
    const result = await new Promise<GitResult>((resolve) => {
      const child = execFile(
        'git',
        fullArgs,
        {
          cwd: options.cwd ?? this.cwd,
          env: { ...this.env, ...options.env },
          maxBuffer: 256 * 1024 * 1024,
          encoding: 'utf8',
          timeout: options.timeoutMs ?? 5 * 60_000,
          killSignal: 'SIGKILL',
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? 128
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    });
    if (result.code !== 0 && !options.allowFailure) {
      throw new GitError(args, result);
    }
    return result;
  }

  /** Run and return trimmed stdout. */
  async out(args: string[], options: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.trim();
  }

  /** Run and return non-empty stdout lines. */
  async lines(args: string[], options: GitRunOptions = {}): Promise<string[]> {
    return (await this.run(args, options)).stdout.split('\n').filter((l) => l.length > 0);
  }

  async paths(args: string[]): Promise<string[]> {
    return (await this.run(args)).stdout.split('\0').filter(Boolean);
  }

  async tree(ref = 'HEAD'): Promise<string> {
    return this.out(['rev-parse', '--verify', `${ref}^{tree}`]);
  }

  async commonDir(): Promise<string> {
    return path.resolve(this.cwd, await this.out(['rev-parse', '--git-common-dir']));
  }

  async requireSupportedVersion(): Promise<void> {
    const version = await this.out(['--version']);
    const match = /git version (\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 45)) {
      throw new Error(`Git 2.45 or newer is required (--empty=stop); found ${version}`);
    }
  }

  async authenticated(token: string | undefined, remote = 'origin'): Promise<Git> {
    const url = await this.remoteUrl(remote);
    return token && url?.startsWith('https://') ? this.withConfig(authExtraHeader(token, url)) : this;
  }

  async revParse(ref: string): Promise<string> {
    return this.out(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  }

  async tryRevParse(ref: string): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async gitDir(): Promise<string> {
    return path.resolve(this.cwd, await this.out(['rev-parse', '--git-dir']));
  }

  async gitPath(name: string): Promise<string> {
    return path.resolve(this.cwd, await this.out(['rev-parse', '--git-path', name]));
  }

  async isShallow(): Promise<boolean> {
    return (await this.out(['rev-parse', '--is-shallow-repository'])) === 'true';
  }

  async mergeBases(a: string, b: string): Promise<string[]> {
    const r = await this.run(['merge-base', '--all', a, b], { allowFailure: true });
    if (r.code === 1) return [];
    if (r.code !== 0) throw new GitError(['merge-base', '--all', a, b], r);
    return r.stdout.split('\n').filter(Boolean);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new GitError(['merge-base', '--is-ancestor', ancestor, descendant], r);
  }

  async revListCount(range: string): Promise<number> {
    return Number(await this.out(['rev-list', '--count', range]));
  }

  /** Resolve the default branch of a remote via its symbolic HEAD. */
  async remoteDefaultBranch(remote: string): Promise<string | undefined> {
    const r = await this.run(['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true });
    if (r.code !== 0) return undefined;
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
    return m?.[1];
  }

  async remoteUrl(remote: string): Promise<string | undefined> {
    const r = await this.run(['remote', 'get-url', remote], { allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async ensureRemote(name: string, url: string): Promise<void> {
    const existing = await this.remoteUrl(name);
    if (existing === undefined) {
      await this.run(['remote', 'add', name, url]);
    } else if (existing !== url) {
      await this.run(['remote', 'set-url', name, url]);
    }
  }

  /** Unmerged index entries grouped by path with the stages present (1=base, 2=ours, 3=theirs). */
  async unmergedPaths(): Promise<Map<string, Set<1 | 2 | 3>>> {
    const out = new Map<string, Set<1 | 2 | 3>>();
    const raw = (await this.run(['ls-files', '-u', '-z'])).stdout;
    for (const rec of raw.split('\0')) {
      if (!rec) continue;
      const m = /^\d+ [0-9a-f]+ ([123])\t([\s\S]*)$/.exec(rec);
      if (!m) continue;
      const stage = Number(m[1]) as 1 | 2 | 3;
      const p = m[2] as string;
      const set = out.get(p) ?? new Set<1 | 2 | 3>();
      set.add(stage);
      out.set(p, set);
    }
    return out;
  }

  async statusPorcelain(): Promise<string[]> {
    // Disable rename detection so each record describes exactly one literal path.
    return this.paths(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']);
  }

  async indexIsEmpty(): Promise<boolean> {
    const r = await this.run(['diff', '--cached', '--quiet'], { allowFailure: true });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new GitError(['diff', '--cached', '--quiet'], r);
  }

  async worktreeAdd(dir: string, commitish: string): Promise<Git> {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await this.run(['worktree', 'add', '--detach', dir, commitish]);
    return this.at(dir);
  }

  async worktreeRemove(dir: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', dir], { allowFailure: true });
    await this.run(['worktree', 'prune'], { allowFailure: true });
  }
}

/** Build a GitHub HTTPS URL from owner/repo or pass a URL through. */
export function repoUrl(spec: string, host = 'https://github.com'): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || spec.startsWith('git@') || spec.startsWith('/') || spec.startsWith('file:')) {
    return spec;
  }
  const trimmed = spec.replace(/\.git$/, '');
  return `${host}/${trimmed}.git`;
}

/** Config entry that authenticates HTTPS pushes to github.com without touching .git/config. */
export function authExtraHeader(token: string, remoteUrl = 'https://github.com/'): Record<string, string> {
  const url = new URL(remoteUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('authentication requires a credential-free HTTPS URL');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { [`http.${url.origin}${url.pathname.replace(/\/$/, '')}/.extraheader`]: `AUTHORIZATION: basic ${basic}` };
}
