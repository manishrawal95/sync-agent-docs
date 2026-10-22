import { createHash } from 'node:crypto';

const STOPWORDS = new Set('runs on port is at box ip uses use listens listen host address the a server'.split(' '));

export function lineHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A value as a whole token: `3000` never matches inside `30001`, `1.10` never inside `1.100`. */
const token = (value: string, flags = 'g'): RegExp => new RegExp(`(?<![\\w.-])${escape(value)}(?![\\w-]|\\.\\w)`, flags);

/** True when the line says nothing beyond the value: only names, punctuation and stopwords are left. */
export function isPureRestatement(line: string, value: string, names: string[]): boolean {
  let rest = line.replace(token(value), ' ');
  for (const name of names) rest = rest.replace(token(name, 'gi'), ' ');
  return (rest.toLowerCase().match(/[a-z]{3,}/g) ?? []).every((w) => STOPWORDS.has(w));
}

export function replaceValue(line: string, from: string, to: string): string {
  return line.replace(token(from), () => to);
}

/** The line with `from` swapped for `to`, or null when `from` is no longer in it. */
export function swapValue(line: string, from: string, to: string): string | null {
  return token(from, '').test(line) ? replaceValue(line, from, to) : null;
}
