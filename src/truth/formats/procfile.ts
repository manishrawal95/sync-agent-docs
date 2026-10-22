import { type FormatParser, type ParsedFact, portsInCommand } from '../parsed.js';

export const parseProcfile: FormatParser = (text) => {
  const facts: ParsedFact[] = [];
  text.split('\n').forEach((lineText, i) => {
    const command = lineText.slice(lineText.indexOf(':') + 1);
    for (const port of portsInCommand(' ' + command)) facts.push({ attribute: 'port', value: port, line: i + 1 });
  });
  return { facts };
};
