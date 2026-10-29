import { CARD_NOTE, factsBody, HEADING, importsCard, INTRO, NO_FACTS, plainCompiler } from '../content.js';

/**
 * CLAUDE.md also imports the project card unless that import already sits outside the block, and then
 * leaves out the project's own facts (the card lists them) unless the file is also another agent file.
 */
export const claude = plainCompiler('claude', 'CLAUDE.md', {
  body: (i) => {
    if (!importsCard(i.outside, i.card)) return [HEADING, INTRO, ...(i.card ? [i.card] : []), factsBody(i.store, i.entityIds)].join('\n\n');
    if (i.shared) return [HEADING, INTRO, factsBody(i.store, i.entityIds)].join('\n\n');
    const rest = factsBody(i.store, i.entityIds.filter((id) => id !== i.project));
    return [HEADING, INTRO, CARD_NOTE, ...(rest === NO_FACTS ? [] : [rest])].join('\n\n');
  },
});
