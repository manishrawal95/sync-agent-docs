#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { renderRollbackSummary, runRollback } from './apply/rollback.js';
import { renderApplySummary, runApply } from './apply/run.js';
import { renderCompileSummary, runCompile } from './compile/run.js';
import { renderLiveTargets } from './doctor/live.js';
import { renderDoctor, runDoctor } from './doctor/run.js';
import type { Asker } from './plan/prompt.js';
import { renderPlanSummary, runPlan } from './plan/run.js';
import { jsonText, printable, renderTerminal } from './report/terminal.js';
import { codeOf, nextStep } from './paths.js';
import { assertFolder, NotAFolderError, runScan } from './scan.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** The folder a command was given, resolved through links; a missing path or a file is a NotAFolderError. */
async function folderArg(path: string | undefined): Promise<string> {
  const given = resolve(path ?? process.cwd());
  await assertFolder(given);
  return realpath(given);
}

/**
 * Text for the terminal, minus control characters: repo and file names can carry ANSI or OSC escapes.
 * --json output goes through jsonText, which escapes them, and the scan report is made printable as it is drawn, with its own colors.
 */
const say = (stream: NodeJS.WriteStream, text: string): void => void stream.write(`${printable(text)}\n`);

let resolvedHome: Promise<string> | undefined;

/**
 * The home folder resolved through links, so paths found under it compare equal to the real paths the scan records. Resolved once.
 * A home that cannot be resolved is used as given; a failure other than a missing folder is named on stderr.
 */
function home(): Promise<string> {
  resolvedHome ??= realpath(homedir()).catch((err: unknown) => {
    if (codeOf(err) !== 'ENOENT') {
      say(process.stderr, `sync-agent-docs: could not resolve your home folder ${homedir()} (${codeOf(err)}); using it as given. ${nextStep(err)}`);
    }
    return homedir();
  });
  return resolvedHome;
}

/** One error line on stderr: a bad path is stated as is, anything else as the command failing, with a leading stage name in the message (`plan --ai: …`) said once. */
function fail(command: string, err: unknown, exitCode = 1): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotAFolderError) say(process.stderr, `sync-agent-docs ${command}: ${message}`);
  else {
    const stage = new RegExp(`^(${command}(?: --[a-z-]+)?): `).exec(message)?.[1];
    say(process.stderr, stage ? `sync-agent-docs ${stage} failed: ${message.slice(stage.length + 2)}` : `sync-agent-docs ${command} failed: ${message}`);
  }
  process.exitCode = exitCode;
}

const program = new Command()
  .name('sync-agent-docs')
  .description('Find conflicting, stale and duplicated infra facts across your repos and coding-agent config.')
  .version(pkg.version)
  .showHelpAfterError('Run sync-agent-docs --help to see the commands.')
  // Commander's own messages echo what was typed, so they get the same treatment as everything else; subcommands inherit it.
  .configureOutput({ writeOut: (s) => void process.stdout.write(printable(s)), writeErr: (s) => void process.stderr.write(printable(s)) });

program
  .command('scan [path]')
  .description('Scan a folder of repos and your agent config for conflicting, stale and duplicated facts.')
  .option('--repos-only', 'skip machine-level files (~/.claude, ~/.ssh/config, crontab, shell rc)')
  .option('--json', 'print scan.json to stdout instead of the report')
  .action(async (path: string | undefined, opts: { reposOnly?: boolean; json?: boolean }) => {
    try {
      const root = await folderArg(path);
      const result = await runScan(root, { home: await home(), reposOnly: opts.reposOnly === true });
      process.stdout.write(opts.json ? `${jsonText(result)}\n` : `${renderTerminal(result, { color: process.stdout.isTTY && !process.env.NO_COLOR })}\n`);
    } catch (err) {
      fail('scan', err);
    }
  });

program
  .command('plan [path]')
  .description('Turn the scan into questions, ask the open ones and write .sync-agent-docs/plan.json.')
  .option('--store <path>', 'truth store folder inside your home folder (default: the last one used, else ~/dev/truth)')
  .option('--repos-only', 'skip machine-level files (~/.claude, ~/.ssh/config, crontab, shell rc)')
  .option('--use-scan', 'read .sync-agent-docs/scan.json instead of scanning again')
  .option('--accept-auto', 'approve every fact a config backs without asking')
  .option('--json', 'print plan.json to stdout and ask nothing')
  .option('--ai', 'ask your claude CLI which entity unlinked doc lines are about (asks first, never sends secret lines; codex and gemini are not supported yet)')
  .action(async (path: string | undefined, opts: { store?: string; reposOnly?: boolean; useScan?: boolean; acceptAuto?: boolean; json?: boolean; ai?: boolean }) => {
    const interactive = !opts.json && process.stdin.isTTY && process.stdout.isTTY;
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    const asker: Asker | undefined = rl ? { ask: (q) => rl.question(printable(q)), print: (t) => say(process.stdout, t) } : undefined;
    try {
      const root = await folderArg(path);
      const plan = await runPlan(root, {
        home: await home(), reposOnly: opts.reposOnly === true, useScan: opts.useScan === true, acceptAuto: opts.acceptAuto === true,
        ...(opts.store ? { store: resolve(opts.store) } : {}), ...(asker ? { asker } : {}),
        ...(opts.ai ? { ai: { path: process.env.PATH ?? '' }, note: (t: string) => say(process.stderr, t) } : {}),
      });
      if (opts.json) process.stdout.write(`${jsonText(plan)}\n`);
      else say(process.stdout, renderPlanSummary(plan));
    } catch (err) {
      fail('plan', err);
    } finally {
      rl?.close();
    }
  });

program
  .command('apply [path]')
  .description('Write the answered plan: the truth store and approved edits, each repo on a new sync-agent-docs/apply-<time> branch.')
  .action(async (path: string | undefined) => {
    try {
      const root = await folderArg(path);
      const entry = await runApply(root, { home: await home() });
      say(process.stdout, renderApplySummary(entry));
    } catch (err) {
      fail('apply', err);
    }
  });

program
  .command('rollback [path]')
  .description('Delete the branches the last apply or compile made and switch each repo back to its branch.')
  .action(async (path: string | undefined) => {
    try {
      const root = await folderArg(path);
      say(process.stdout, renderRollbackSummary(await runRollback(root)));
    } catch (err) {
      fail('rollback', err);
    }
  });

program
  .command('compile [path]')
  .description('Write the store\'s facts into each repo\'s agent files, on new branches, without merging or pushing.')
  .option('--store <path>', 'truth store folder inside your home folder (default: the last one used, else ~/dev/truth)')
  .action(async (path: string | undefined, opts: { store?: string }) => {
    try {
      const root = await folderArg(path);
      const store = opts.store ? resolve(opts.store) : undefined;
      say(process.stdout, renderCompileSummary(await runCompile(root, { home: await home(), store })));
    } catch (err) {
      fail('compile', err);
    }
  });

program
  .command('doctor [path]')
  .description('Recheck every file and branch against the store and report drift. Exits 0 when clean, 1 on drift, 2 when doctor itself fails.')
  .option('--store <path>', 'truth store folder inside your home folder (default: the last one used, else ~/dev/truth)')
  .option('--repos-only', 'skip machine-level files (~/.claude, ~/.ssh/config, crontab, shell rc) in the rescan')
  .option('--json', 'print the result as JSON instead of the report')
  .option('--live', 'also make read-only HEAD requests and TCP connects to the URLs, domains and ip:port pairs the store records')
  // A usage error is doctor failing (2), never drift (1), so a cron job reading the code is not misled.
  .exitOverride((err) => process.exit(err.exitCode === 0 ? 0 : 2))
  .action(async (path: string | undefined, opts: { store?: string; reposOnly?: boolean; json?: boolean; live?: boolean }) => {
    try {
      const root = await folderArg(path);
      const result = await runDoctor(root, {
        home: await home(), store: opts.store ? resolve(opts.store) : undefined, reposOnly: opts.reposOnly === true, live: opts.live === true,
        onLiveTargets: (targets) => say(process.stderr, renderLiveTargets(targets)),
      });
      if (opts.json) process.stdout.write(`${jsonText(result)}\n`);
      else say(process.stdout, renderDoctor(result));
      process.exitCode = result.drift ? 1 : 0;
    } catch (err) {
      fail('doctor', err, 2);
    }
  });

await program.parseAsync();
