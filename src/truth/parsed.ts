import type { Attribute, Entity } from '../types.js';

/** A fact as one config file states it, before it is tied to an entity. */
export interface ParsedFact {
  attribute: Attribute; value: string; line: number;
  /** App (pm2 app, compose service, worker) the fact belongs to; the repo's project when absent. */
  app?: string;
}

/** An ssh `Host` line: its first non-wildcard pattern names the host, the rest are `aliases`. */
export interface ParsedHost { alias: string; aliases?: string[]; hostName?: string; line: number }

/** What one config file says, in repo-neutral terms; parseTruth turns it into entities and facts. */
export interface Parsed {
  apps?: string[];
  projectNames?: string[];
  identifiers?: Entity['identifiers'];
  hosts?: ParsedHost[];
  facts?: ParsedFact[];
  corpus?: string[];
}

/** Reads the text of one config file. Throws on malformed input; parseTruth turns that into a skip note. */
export type FormatParser = (text: string) => Parsed;

/** Escapes text from a scanned file so it matches itself inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 1-based number of the first line matching needle at or after line `from`; `from` when none does.
 * A string matches only as a whole token (no `[A-Za-z0-9_.-]` on either side), so `80` skips `8080`.
 */
export function lineOf(text: string, needle: string | RegExp, from = 1): number {
  const pattern = typeof needle === 'string' ? new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(needle)}(?![A-Za-z0-9_.-])`) : needle;
  const lines = text.split('\n');
  for (let i = from - 1; i < lines.length; i++) if (pattern.test(lines[i] ?? '')) return i + 1;
  return from;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** The one port-flag pattern: `short` is set for `-p`, which command and doc parsing treat differently. */
const PORT_FLAG = /(?:^|\s)(?:(?<short>-p)|--port)(?:\s+|=)(?<flag>\d{1,5})\b|\bPORT=(?<env>\d{1,5})\b/g;

/** Ports a start command sets with -p N, --port N or PORT=N. */
export function portsInCommand(command: string): string[] {
  const ports: string[] = [];
  for (const m of command.matchAll(PORT_FLAG)) {
    const port = m.groups?.flag ?? m.groups?.env;
    if (port && isPort(port)) ports.push(port);
  }
  return ports;
}

const DEV_SERVER_COMMANDS = new Set([
  'next', 'vite', 'nuxt', 'astro', 'remix', 'serve', 'http-server', 'live-server', 'wrangler', 'vercel', 'netlify',
  'uvicorn', 'gunicorn', 'flask', 'rails', 'hugo', 'jekyll', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'docker',
]);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_SCRIPTS = new Set(['run', 'start', 'dev']);
/** Tools whose `-p` names a process, a path or an ssh port; a dev command before one of them does not own its `-p`. */
const OTHER_TOOLS = new Set(['ps', 'lsof', 'kill', 'pkill', 'pgrep', 'ssh', 'scp', 'mkdir', 'top']);
/** How many words before `-p` may hold the dev command: `npm run dev -- -p` is the longest real shape. */
const LOOKBACK = 4;

/** True when the words just before a `-p` end in a dev server command and no other tool sits between. */
function followsDevCommand(before: string): boolean {
  const words = before.trim().split(/\s+/).filter(Boolean).slice(-LOOKBACK);
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i] ?? '';
    if (OTHER_TOOLS.has(word)) return false;
    if (!DEV_SERVER_COMMANDS.has(word)) continue;
    return !PACKAGE_RUNNERS.has(word) || PACKAGE_SCRIPTS.has(words[i + 1] ?? '');
  }
  return false;
}

/**
 * Ports a line of prose or a doc code block sets. `--port N` and `PORT=N` count anywhere; `-p N` counts only when a
 * dev server command (next, vite, `npm run dev`...) comes just before it in its segment (split on backticks, `|`,
 * `&&`, `;`), since `ps -p 1234` names a process.
 */
export function portsInDocLine(line: string): string[] {
  const ports: string[] = [];
  for (const segment of line.split(/`|\||&&|;/)) {
    for (const m of segment.matchAll(PORT_FLAG)) {
      const port = m.groups?.flag ?? m.groups?.env;
      if (port && isPort(port) && (!m.groups?.short || followsDevCommand(segment.slice(0, m.index)))) ports.push(port);
    }
  }
  return ports;
}

export function isPort(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Host part of a route or URL pattern like `https://*.example.com/api/*`. */
export function hostOf(pattern: string): string {
  return pattern.replace(/^[a-z]+:\/\//i, '').split('/')[0]?.replace(/^\*\.?/, '').replace(/:\d+$/, '') ?? '';
}
