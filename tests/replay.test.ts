import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectScan, runScan } from '../src/scan.js';
import { describeExpected, loadAnswerKey, matches } from './helpers/replay.js';

/**
 * Replays the owner's real pre-cleanup history. Opt-in and local only: the answer key and the
 * snapshots never enter this repo. Set SYNC_AGENT_DOCS_REPLAY_DIR to the folder filled by
 * scripts/replay-snapshot.ts; SYNC_AGENT_DOCS_REPLAY_KEY overrides the answer key path.
 */
const dir = process.env.SYNC_AGENT_DOCS_REPLAY_DIR;
const keyPath = process.env.SYNC_AGENT_DOCS_REPLAY_KEY ?? join(homedir(), '.local', 'share', 'sync-agent-docs-replay', 'expected.json');

describe.skipIf(!dir)('replay', () => {
  it('pre-cleanup snapshot finds every expected finding', async () => {
    const key = loadAnswerKey(await readFile(keyPath, 'utf8'), keyPath);
    const { findings } = await runScan(dir as string, { home: homedir(), reposOnly: true });
    const missed = key.expected.filter((e) => !findings.some((f) => matches(f, e))).map(describeExpected);
    expect(missed).toEqual([]);
  }, 120_000);

  it('current setup has no conflicts outside currentReal', async () => {
    const key = loadAnswerKey(await readFile(keyPath, 'utf8'), keyPath);
    // collectScan, not runScan: checking the live setup must not write ~/dev/.sync-agent-docs/.
    const { findings } = await collectScan(join(homedir(), 'dev'), { home: homedir(), reposOnly: false });
    const unexpected = findings
      .filter((f) => (f.type === 'conflict' || f.type === 'global-local') && !key.currentReal.some((e) => matches(f, e)))
      .map((f) => f.message);
    expect(unexpected).toEqual([]);
  }, 120_000);
});
