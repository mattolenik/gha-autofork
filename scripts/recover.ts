import * as path from 'node:path';
import { restoreRecovery } from '../src/recovery.js';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('usage: npx tsx scripts/recover.ts <artifact/recovery> <new-directory>');
await restoreRecovery(path.resolve(source), path.resolve(destination));
console.log('Recovered worktree and index. Inspect git status, resolve remaining conflicts, then git rebase --continue if a rebase is active. Verify the entire patch series before pushing.');
