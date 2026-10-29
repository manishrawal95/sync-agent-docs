import { corpusTokens } from './corpus-only.js';
import { escapeRegExp, type FormatParser, lineOf, portsInCommand } from '../parsed.js';

export const parsePackageJson: FormatParser = (text) => {
  const pkg = JSON.parse(text) as { name?: unknown; scripts?: unknown };
  const name = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : null;
  const facts = [];
  const corpus = name ? [name] : [];
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    // An earlier object (exports, say) can hold the same key, so the search starts at scripts.
    const from = lineOf(text, /"scripts"\s*:/);
    for (const [key, command] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof command !== 'string') continue;
      corpus.push(...corpusTokens(command));
      const line = lineOf(text, new RegExp(`"${escapeRegExp(key)}"\\s*:`), from);
      const ports = portsInCommand(command);
      // `next dev` and `next start` listen on 3000 unless told otherwise.
      if (ports.length === 0 && /\bnext (?:dev|start)\b/.test(command)) ports.push('3000');
      for (const port of ports) facts.push({ attribute: 'port' as const, value: port, line });
    }
  }
  return { projectNames: name ? [name] : [], facts, corpus };
};
