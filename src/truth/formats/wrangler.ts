import { parse as parseToml } from 'smol-toml';
import { type FormatParser, hostOf, lineOf, type ParsedFact } from '../parsed.js';

interface Wrangler {
  name?: unknown; account_id?: unknown; vars?: unknown; route?: unknown; routes?: unknown;
}

function routePatterns(config: Wrangler): string[] {
  const raw = [config.route, ...(Array.isArray(config.routes) ? config.routes : [])];
  return raw.flatMap((r) => {
    if (typeof r === 'string') return [r];
    if (r && typeof r === 'object' && typeof (r as { pattern?: unknown }).pattern === 'string') return [(r as { pattern: string }).pattern];
    return [];
  });
}

/**
 * JSONC to JSON: drops `//` and `/* *\/` comments and trailing commas, never touching text inside a string
 * (so "https://x" and "a,}" survive). Comments become spaces, newlines kept, so JSON.parse errors keep their positions.
 */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') { out += ' '; i += 1; }
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return dropTrailingCommas(out);
}

/** Blanks each comma whose next non-space character closes an object or array; strings are skipped whole. */
function dropTrailingCommas(text: string): string {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === '"') {
      i += 1;
      while (i < chars.length && chars[i] !== '"') i += chars[i] === '\\' ? 2 : 1;
    } else if (chars[i] === ',') {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j] ?? '')) j += 1;
      if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function wranglerParser(read: (text: string) => Wrangler): FormatParser {
  return (text) => {
    const config = read(text);
    const app = typeof config.name === 'string' ? config.name : undefined;
    const facts: ParsedFact[] = [];
    const corpus: string[] = [];
    if (config.vars && typeof config.vars === 'object') {
      for (const key of Object.keys(config.vars)) {
        facts.push({ attribute: 'env', value: key, line: lineOf(text, key), app });
      }
    }
    for (const pattern of routePatterns(config)) {
      const host = hostOf(pattern);
      if (host) facts.push({ attribute: 'domain', value: host, line: lineOf(text, pattern), app });
    }
    if (typeof config.account_id === 'string') corpus.push(config.account_id);
    return { apps: app ? [app] : [], facts, corpus };
  };
}

export const parseWranglerToml = wranglerParser((text) => parseToml(text) as Wrangler);
export const parseWranglerJson = wranglerParser((text) => JSON.parse(stripJsonc(text)) as Wrangler);
