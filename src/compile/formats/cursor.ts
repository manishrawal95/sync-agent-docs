import { join } from 'node:path';
import { exists, plainCompiler } from '../content.js';

/** Cursor reads every rule in `.cursor/rules/`, so sync-agent-docs keeps its own file there. */
export const cursor = plainCompiler('cursor', join('.cursor', 'rules', 'sync-agent-docs.mdc'), {
  present: (repoPath) => exists(join(repoPath, '.cursor', 'rules')),
  newFilePrefix: '---\ndescription: Infra facts compiled by sync-agent-docs from the truth store\nalwaysApply: true\n---\n\n',
});
