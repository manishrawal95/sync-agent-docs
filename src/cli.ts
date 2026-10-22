#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const program = new Command()
  .name('truthfile')
  .description('Find conflicting, stale and duplicated infra facts across your repos and coding-agent config.')
  .version(pkg.version)
  .showHelpAfterError('Run truthfile --help to see the commands.');

program
  .command('scan [path]')
  .description('Scan a folder of repos and your agent config for conflicting, stale and duplicated facts.')
  .action(() => {
    process.stderr.write('scan is not built yet\n');
    process.exitCode = 2;
  });

await program.parseAsync();
