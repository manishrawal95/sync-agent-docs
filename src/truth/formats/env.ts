import type { Parsed, ParsedFact } from '../parsed.js';
import { streamLines } from '../stream.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variable names from a .env file (or, with exportOnly, `export NAME=` lines of a shell rc).
 * Each line is cut at `=` as it streams past, so a value is never stored, returned or logged.
 */
export async function parseEnvNames(path: string, exportOnly = false): Promise<Parsed> {
  const facts: ParsedFact[] = [];
  let openQuote: string | null = null; // a quoted value spanning lines (a PEM key, say): its lines are value, never names
  let openKey = false; // an unquoted key body (`KEY=-----BEGIN ... PRIVATE KEY-----` then bare lines): same
  await streamLines(path, (raw, line) => {
    if (openQuote) {
      if (raw.includes(openQuote)) openQuote = null;
      return;
    }
    if (openKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(raw)) openKey = false;
      return;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) return;
    const left = raw.slice(0, eq).trim();
    if (exportOnly && !left.startsWith('export ')) return;
    const name = left.replace(/^export\s+/, '');
    const value = raw.slice(eq + 1).trim();
    const quote = value[0] === '"' || value[0] === "'" || value[0] === '`' ? value[0] : null;
    if (quote && value.indexOf(quote, 1) < 0) openQuote = quote;
    else if (!quote && /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(value)) openKey = true;
    if (NAME.test(name)) facts.push({ attribute: 'env', value: name, line });
  });
  return { facts, corpus: facts.map((f) => f.value) };
}
