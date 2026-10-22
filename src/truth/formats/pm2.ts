import { type FormatParser, isPort, lineAt, type ParsedFact, portsInCommand } from '../parsed.js';

const APP_NAME = /\bname\s*:\s*['"`]([^'"`]+)['"`]/g;
const ARGS = /\bargs\s*:\s*['"`]([^'"`]*)['"`]/g;
const PORT_KEY = /\bPORT['"]?\s*:\s*['"]?(\d{1,5})\b/g;
const QUOTED_PATH = /['"`]((?:\/|~\/)[^'"`\s]+)['"`]/g;
const ENV_KEY = /\b([A-Z][A-Z0-9_]{2,})['"]?\s*:/g;

/**
 * pm2 ecosystem files are JavaScript and are never executed: each `name:` starts an app,
 * and its port comes from `-p N` in args or `PORT: N` before the next app.
 */
export const parsePm2: FormatParser = (text) => {
  const starts = [...text.matchAll(APP_NAME)];
  const apps: string[] = [];
  const facts: ParsedFact[] = [];
  const corpus: string[] = [];
  starts.forEach((m, i) => {
    const app = m[1] ?? '';
    const begin = m.index;
    const end = starts[i + 1]?.index ?? text.length;
    const chunk = text.slice(begin, end);
    apps.push(app);
    const ports = new Map<string, number>();
    for (const a of chunk.matchAll(ARGS)) {
      for (const port of portsInCommand(' ' + (a[1] ?? ''))) if (!ports.has(port)) ports.set(port, begin + a.index);
    }
    for (const p of chunk.matchAll(PORT_KEY)) {
      const port = p[1] ?? '';
      if (isPort(port) && !ports.has(port)) ports.set(port, begin + p.index);
    }
    for (const [port, offset] of ports) {
      facts.push({ attribute: 'port', value: port, line: lineAt(text, offset), app });
    }
    for (const q of chunk.matchAll(QUOTED_PATH)) if (q[1]) corpus.push(q[1]);
    for (const k of chunk.matchAll(ENV_KEY)) if (k[1]) corpus.push(k[1]);
  });
  return { apps, facts, corpus };
};
