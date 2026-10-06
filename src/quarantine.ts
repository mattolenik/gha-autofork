import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AutopatchError } from './errors.js';
import { validateFilePath } from './state.js';

/**
 * Files and directories that coding agents read as instructions. They are moved out of the worktree
 * around conflict resolution as defense in depth, then restored before staging. Review calls rely on
 * disabled CLI instruction discovery so they can inspect instruction-file changes as data.
 */
export const INSTRUCTION_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.cursorrules',
  '.cursor',
  '.github/copilot-instructions.md',
  '.claude',
  '.codex',
  '.agents',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
  'GEMINI.md',
  '.windsurfrules',
] as const;

export interface Quarantine {
  /** Paths that were moved, relative to the worktree. */
  moved: string[];
  restore(): Promise<void>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move instruction files out of `worktree` into `holdDir`. Paths in `keep` (typically the conflicted
 * files the agent must edit) are left alone.
 */
export async function quarantine(worktree: string, holdDir: string, keep: Iterable<string> = []): Promise<Quarantine> {
  const keepSet = new Set(Array.from(keep));
  const root = await fs.realpath(worktree);
  const moved: string[] = [];
  await fs.mkdir(holdDir, { recursive: true });
  const move = async (rel: string): Promise<void> => {
    if (keepSet.has(rel)) return;
    const src = path.join(worktree, rel);
    if (!(await exists(src))) return;
    if ([...keepSet].some(p => p.startsWith(`${rel}/`))) {
      if (!(await fs.lstat(src)).isDirectory()) throw new AutopatchError('FAILED_TAMPERED', 'instruction directory was replaced by a symlink or file');
      for (const name of await fs.readdir(src)) await move(`${rel}/${name}`);
      return;
    }
    // Validate ancestors without following a repository-controlled symlink.
    await validateFilePath(worktree, `${rel}/__quarantine_probe__`).catch(async e => {
      if (!(await fs.lstat(src)).isDirectory()) await validateFilePath(worktree, rel);
      else throw e;
    });
    const dst = path.join(holdDir, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    moved.push(rel);
  };
  try {
    for (const rel of INSTRUCTION_PATHS) await move(rel);
  } catch (e) {
    for (const rel of moved.reverse()) await fs.rename(path.join(holdDir, rel), path.join(worktree, rel));
    throw e;
  }
  let restored = false;
  return {
    moved,
    async restore() {
      if (restored) return;
      restored = true;
      if (await fs.realpath(worktree) !== root) throw new AutopatchError('FAILED_TAMPERED', 'worktree root changed during quarantine');
      const recreated: string[] = [];
      for (const rel of moved) {
        const src = path.join(holdDir, rel);
        const dst = path.join(worktree, rel);
        if (!(await exists(src))) continue;
        if (path.dirname(rel) !== '.') {
          try { await validateFilePath(worktree, `${path.dirname(rel)}/__restore_probe__`); }
          catch { throw new AutopatchError('FAILED_TAMPERED', 'agent replaced a quarantined file ancestor', [rel]); }
        }
        if (await exists(dst)) recreated.push(rel);
        await fs.rm(dst, { recursive: true, force: true });
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.rename(src, dst);
      }
      if (recreated.length) throw new AutopatchError('FAILED_TAMPERED', 'agent recreated quarantined instruction files', recreated);
    },
  };
}
