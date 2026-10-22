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

/** 1-based number of the first line containing needle at or after line `from`; 1 when absent. */
export function lineOf(text: string, needle: string, from = 1): number {
  const lines = text.split('\n');
  for (let i = from - 1; i < lines.length; i++) if (lines[i]?.includes(needle)) return i + 1;
  return 1;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

const PORT_FLAG = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{1,5})\b|\bPORT=(\d{1,5})\b/g;

/** Ports a start command sets with -p N, --port N or PORT=N. */
export function portsInCommand(command: string): string[] {
  const ports: string[] = [];
  for (const m of command.matchAll(PORT_FLAG)) {
    const port = m[1] ?? m[2];
    if (port && isPort(port)) ports.push(port);
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
