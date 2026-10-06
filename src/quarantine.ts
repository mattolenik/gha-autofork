import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Files and directories that coding agents read as instructions. They are moved out of the worktree
 * around every agent call so upstream content cannot steer the agent, then restored before staging.
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
  const moved: string[] = [];
  await fs.mkdir(holdDir, { recursive: true });
  for (const rel of INSTRUCTION_PATHS) {
    if (keepSet.has(rel)) continue;
    const src = path.join(worktree, rel);
    if (!(await exists(src))) continue;
    const dst = path.join(holdDir, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    moved.push(rel);
  }
  let restored = false;
  return {
    moved,
    async restore() {
      if (restored) return;
      restored = true;
      for (const rel of moved) {
        const src = path.join(holdDir, rel);
        const dst = path.join(worktree, rel);
        if (!(await exists(src))) continue;
        // If the agent recreated the file, the agent's version is discarded: it was not supposed to touch it.
        await fs.rm(dst, { recursive: true, force: true });
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.rename(src, dst);
      }
    },
  };
}
