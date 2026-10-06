import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Git } from '../../src/git.js';

/**
 * Builds a realistic upstream + fork pair with plain git:
 *
 *   upstream.git   bare remote standing in for the OSS project
 *   upstreamWork   working clone used to advance upstream
 *   origin.git     bare remote standing in for the fork on GitHub
 *   fork           working clone of origin with `upstream` remote added (what actions/checkout gives us)
 *
 * The fork carries three patches on top of upstream's initial history unless `patches` is overridden.
 */
export interface Fixture {
  root: string;
  upstreamBare: string;
  originBare: string;
  upstreamWork: Git;
  fork: Git;
  branch: string;
  /** Sha of the upstream commit the fork was based on. */
  base: string;
  /** Shas of the fork's patches in order. */
  patchShas: string[];
  cleanup(): Promise<void>;
}

export type FileMap = Record<string, string | null>;

const FIX_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

export function fixtureGit(cwd: string): Git {
  return new Git(cwd, { env: FIX_ENV });
}

export async function writeFiles(dir: string, files: FileMap): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      await fs.rm(abs, { force: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  }
}

/** Stage the given files (adds and deletions) and commit. Returns the new sha. */
export async function commitFiles(git: Git, files: FileMap, message: string): Promise<string> {
  await writeFiles(git.cwd, files);
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) await git.run(['rm', '-q', '--cached', '--ignore-unmatch', '--', rel]);
    else await git.run(['add', '--', rel]);
  }
  await git.run(['commit', '-q', '--allow-empty', '-m', message]);
  return git.revParse('HEAD');
}

export const UPSTREAM_INITIAL: FileMap = {
  'README.md': '# widgets\n\nA library of widgets.\n',
  'src/lib.js': ['export function greet(name) {', "  return 'hello ' + name;", '}', '', 'export const VERSION = 1;', ''].join(
    '\n',
  ),
  'src/util.js': ['export function clamp(v, lo, hi) {', '  return Math.min(hi, Math.max(lo, v));', '}', ''].join('\n'),
  'docs/guide.md': ['# Guide', '', '| a | b |', '|===|===|', '| 1 | 2 |', ''].join('\n'),
};

export type PatchSpec = { files: FileMap; message: string };

export const DEFAULT_PATCHES: PatchSpec[] = [
  {
    message: 'fork: greet shouts',
    files: {
      'src/lib.js': ['export function greet(name) {', "  return 'HELLO ' + name.toUpperCase();", '}', '', 'export const VERSION = 1;', ''].join(
        '\n',
      ),
    },
  },
  {
    message: 'fork: add local notes',
    files: { 'NOTES.fork.md': 'Personal notes for this fork.\n' },
  },
  {
    message: 'fork: clamp accepts strings',
    files: {
      'src/util.js': [
        'export function clamp(v, lo, hi) {',
        '  v = Number(v);',
        '  return Math.min(hi, Math.max(lo, v));',
        '}',
        '',
      ].join('\n'),
    },
  },
];

export interface FixtureOptions {
  branch?: string;
  patches?: PatchSpec[];
  upstreamInitial?: FileMap;
}

const templates = new Map<string, Promise<string>>();
const templateRoots: string[] = [];
process.on('exit', () => {
  for (const r of templateRoots) {
    try {
      fsSync.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function buildTemplate(opts: FixtureOptions): Promise<string> {
  const branch = opts.branch ?? 'main';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-template-'));
  templateRoots.push(root);
  const upstreamBare = path.join(root, 'upstream.git');
  const originBare = path.join(root, 'origin.git');
  const upstreamWorkDir = path.join(root, 'upstream-work');
  const forkDir = path.join(root, 'fork');

  const rootGit = fixtureGit(root);
  await rootGit.run(['init', '-q', '--bare', `--initial-branch=${branch}`, upstreamBare]);
  await rootGit.run(['clone', '-q', upstreamBare, upstreamWorkDir]);
  const upstreamWork = fixtureGit(upstreamWorkDir);
  await upstreamWork.run(['checkout', '-q', '-b', branch]);
  await commitFiles(upstreamWork, opts.upstreamInitial ?? UPSTREAM_INITIAL, 'initial import');
  await commitFiles(upstreamWork, { 'CHANGELOG.md': '# Changelog\n\n- 0.1.0 initial\n' }, 'add changelog');
  await upstreamWork.run(['push', '-q', '-u', 'origin', branch]);
  const base = await upstreamWork.revParse('HEAD');

  // The fork on GitHub starts as a clone of upstream.
  await rootGit.run(['clone', '-q', '--bare', upstreamBare, originBare]);
  await rootGit.run(['--git-dir', originBare, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);

  await rootGit.run(['clone', '-q', originBare, forkDir]);
  const fork = fixtureGit(forkDir);
  await fork.run(['checkout', '-q', branch]);
  await fork.run(['remote', 'add', 'upstream', upstreamBare]);
  const patchShas: string[] = [];
  for (const p of opts.patches ?? DEFAULT_PATCHES) {
    patchShas.push(await commitFiles(fork, p.files, p.message));
  }
  await fork.run(['push', '-q', 'origin', branch]);
  await fork.run(['fetch', '-q', 'upstream']);
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ base, patchShas }));
  return root;
}

/**
 * Fixtures are built once per option set and then copied, because building one takes dozens of git
 * invocations. Remote URLs are rewritten to point inside the copy.
 */
export async function createFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const branch = opts.branch ?? 'main';
  const key = JSON.stringify(opts);
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate(opts);
    templates.set(key, template);
  }
  const templateRoot = await template;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-fixture-'));
  await fs.cp(templateRoot, root, { recursive: true });
  const upstreamBare = path.join(root, 'upstream.git');
  const originBare = path.join(root, 'origin.git');
  const upstreamWork = fixtureGit(path.join(root, 'upstream-work'));
  const fork = fixtureGit(path.join(root, 'fork'));
  await upstreamWork.run(['remote', 'set-url', 'origin', upstreamBare]);
  await fork.run(['remote', 'set-url', 'origin', originBare]);
  await fork.run(['remote', 'set-url', 'upstream', upstreamBare]);
  const meta = JSON.parse(await fs.readFile(path.join(root, 'meta.json'), 'utf8')) as { base: string; patchShas: string[] };

  return {
    root,
    upstreamBare,
    originBare,
    upstreamWork,
    fork,
    branch,
    base: meta.base,
    patchShas: meta.patchShas,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Commit on upstream's working clone and push to upstream.git; fork must fetch afterwards. */
export async function advanceUpstream(fx: Fixture, files: FileMap, message: string): Promise<string> {
  const sha = await commitFiles(fx.upstreamWork, files, message);
  await fx.upstreamWork.run(['push', '-q', 'origin', fx.branch]);
  return sha;
}

/** Fetch upstream into the fork checkout the way the action does: heads only, no tags. */
export async function fetchUpstream(fx: Fixture): Promise<void> {
  await fx.fork.run(['fetch', '-q', '--no-tags', 'upstream', `+refs/heads/*:refs/remotes/upstream/*`]);
}

/** Cherry-pick one of the fork's patches onto upstream so it is "absorbed". */
export async function absorbPatchUpstream(fx: Fixture, patchSha: string): Promise<string> {
  await fx.upstreamWork.run(['fetch', '-q', fx.originBare, `refs/heads/${fx.branch}:refs/remotes/fork/${fx.branch}`]);
  await fx.upstreamWork.run(['cherry-pick', '--empty=keep', patchSha]);
  await fx.upstreamWork.run(['push', '-q', 'origin', fx.branch]);
  return fx.upstreamWork.revParse('HEAD');
}

/** Add a merge commit to the fork branch (merging a side branch), making the series non-linear. */
export async function addMergeCommitToFork(fx: Fixture): Promise<string> {
  const g = fx.fork;
  await g.run(['checkout', '-q', '-b', 'side', `${fx.branch}~1`]);
  await commitFiles(g, { 'side.txt': 'side work\n' }, 'side: work');
  await g.run(['checkout', '-q', fx.branch]);
  await g.run(['merge', '-q', '--no-ff', '--no-edit', 'side']);
  await g.run(['branch', '-q', '-D', 'side']);
  return g.revParse('HEAD');
}

/** Build a criss-cross history between upstream and fork so merge-base --all returns two commits. */
export async function makeCrissCross(fx: Fixture): Promise<void> {
  // X (upstream side) and Y (fork side) both diverge from base, merge each other, then continue.
  const u = fx.upstreamWork;
  const f = fx.fork;
  await commitFiles(u, { 'x.txt': 'x1\n' }, 'x1');
  await u.run(['push', '-q', 'origin', fx.branch]);

  await f.run(['reset', '-q', '--hard', fx.base]);
  await commitFiles(f, { 'y.txt': 'y1\n' }, 'y1');
  await f.run(['fetch', '-q', 'upstream']);
  const x1 = await f.revParse(`upstream/${fx.branch}`);
  await f.run(['merge', '-q', '--no-ff', '--no-edit', x1]); // Y merges X
  const ym = await f.revParse('HEAD');
  await f.run(['push', '-q', '--force', 'origin', fx.branch]);

  await u.run(['fetch', '-q', fx.originBare, `refs/heads/${fx.branch}:refs/remotes/fork/${fx.branch}`]);
  const y1 = await u.revParse(`${ym}^1`);
  await u.run(['merge', '-q', '--no-ff', '--no-edit', y1]); // X merges Y
  await commitFiles(u, { 'x.txt': 'x2\n' }, 'x2');
  await u.run(['push', '-q', 'origin', fx.branch]);
  await commitFiles(f, { 'y.txt': 'y2\n' }, 'y2');
  await f.run(['push', '-q', '--force', 'origin', fx.branch]);
  await f.run(['fetch', '-q', 'upstream']);
}

export async function readFile(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), 'utf8');
}

export function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
