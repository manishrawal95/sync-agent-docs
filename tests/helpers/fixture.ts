import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

async function markedRepos(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = entries.some((e) => e.name === '.fixture-repo') ? [dir] : [];
  for (const e of entries) {
    if (e.isDirectory()) found.push(...(await markedRepos(join(dir, e.name))));
  }
  return found;
}

/**
 * Copies a fixture to a temp dir, makes its marked folders git repos and plants a fresh secret.
 * `commit: true` commits everything on `main` in each repo, so apply sees clean trees.
 */
export async function materializeFixture(name: string, opts: { commit?: boolean } = {}): Promise<{ root: string; home: string; secret: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), `sync-agent-docs-${name}-`)));
  const home = join(base, 'home');
  const root = join(home, 'dev');
  await cp(join(FIXTURES, name, 'dev'), root, { recursive: true });
  await cp(join(FIXTURES, name, 'home'), home, { recursive: true });
  for (const repo of await markedRepos(root)) {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  }
  // Built at runtime so no secret-shaped string is ever committed; the 9 keeps it token-shaped (a digit is required).
  const secret = 'tf9' + randomBytes(24).toString('base64url');
  await writeFile(join(root, 'shop', 'AGENTS.md'), '# Agents\n\n' + 'API_TOKEN' + '=' + secret + '\n');
  if (opts.commit) {
    for (const repo of await markedRepos(root)) {
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: repo });
    }
  }
  return { root, home, secret };
}
