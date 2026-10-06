import * as path from 'node:path';
import { restoreRecovery } from '../src/recovery.js';

const [source, destination, basisSource] = process.argv.slice(2);
if (!source || !destination || !basisSource) throw new Error('usage: npx tsx scripts/recover.ts <artifact/recovery> <new-directory> <fork-url-or-existing-clone>');
await restoreRecovery(path.resolve(source), path.resolve(destination), basisSource, process.env.AUTOPATCH_RECOVERY_TOKEN);
console.log('Recovered worktree and index. Inspect git status, resolve remaining conflicts, then git rebase --continue if a rebase is active. Verify the entire patch series before pushing.');
