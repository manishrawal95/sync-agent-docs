import type { Parsed, ParsedFact } from '../parsed.js';
import { lineHasSecret, looksLikeToken } from '../../claims/secrets.js';
import { streamLines } from '../stream.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/** Whether `text`, from `from`, holds a closing `quote`: one after an even run of backslashes, since dotenv reads `\'`, `\"` and an escaped backtick as part of the value. */
function closesQuote(text: string, quote: string, from: number): boolean {
  for (let i = text.indexOf(quote, from); i >= 0; i = text.indexOf(quote, i + 1)) {
    let slashes = 0;
    while (text[i - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

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
      if (closesQuote(raw, openQuote, 0)) openQuote = null;
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
    if (quote && !closesQuote(value, quote, 1)) openQuote = quote;
    else if (!quote && /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(value)) openKey = true;
    // Backstop for a value the quote rules misjudge: a token-shaped name is a secret's body line, never a variable, unless it is upper snake with an underscore (real env names are; a body has lowercase or no underscore).
    const secretBody = (looksLikeToken(name) && !(UPPER_SNAKE.test(name) && name.includes('_'))) || lineHasSecret(`${name}=x`);
    if (NAME.test(name) && !secretBody) facts.push({ attribute: 'env', value: name, line });
  });
  return { facts, corpus: facts.map((f) => f.value) };
}
