/**
 * Checks out each repo of a replay answer key at its pre-cleanup commit, read-only toward the
 * source repos: `tsx scripts/replay-snapshot.ts <expected.json> <outDir>`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAnswerKey } from '../tests/helpers/replay.js';

async function main(): Promise<void> {
  const [keyPath, outDir] = process.argv.slice(2);
  if (!keyPath || !outDir) throw new Error('usage: tsx scripts/replay-snapshot.ts <expected.json> <outDir>');
  const key = loadAnswerKey(await readFile(keyPath, 'utf8'), keyPath);
  for (const { repo, source, sha } of key.snapshots) {
    const dest = join(outDir, repo);
    if (existsSync(dest)) throw new Error(`replay: ${dest} already exists. Pass an empty outDir so no checkout is reused.`);
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', source, dest], { stdio: 'inherit' });
    execFileSync('git', ['-C', dest, 'checkout', '--quiet', '--detach', sha], { stdio: 'inherit' });
    process.stdout.write(`${repo} @ ${sha.slice(0, 7)}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
