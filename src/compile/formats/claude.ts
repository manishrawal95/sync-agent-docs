import { factsBody, HEADING, INTRO, plainCompiler } from '../content.js';

/** CLAUDE.md also imports the project card, unless that import already sits outside the block. */
export const claude = plainCompiler('claude', 'CLAUDE.md', {
  body: (i) => {
    const imported = !i.card || i.outside.split(/\r?\n/).some((l) => l.trim() === i.card);
    return [HEADING, INTRO, ...(imported ? [] : [i.card]), factsBody(i.store, i.entityIds)].join('\n\n');
  },
});
