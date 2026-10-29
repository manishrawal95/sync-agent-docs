import { isPort, portsInDocLine } from '../truth/parsed.js';
import type { Attribute, Mention, SourceFile } from '../types.js';
import { lineHasSecret } from './secrets.js';

// No `sh`: `deploy.sh` is a script far more often than a domain.
const TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'xyz', 'co', 'ai', 'me', 'so', 'cloud', 'tech',
  'info', 'biz', 'us', 'uk', 'ca', 'de', 'eu', 'in', 'au', 'site', 'page', 'run', 'tools', 'link', 'gg',
]);
const FS_ROOTS = new Set(['etc', 'opt', 'var', 'usr', 'home', 'Users', 'root', 'srv', 'tmp', 'Library', 'private', 'mnt', 'Volumes']);

/** Public DNS resolvers a doc names as a setting; they never name one of the user's hosts. Exact match only. */
const PUBLIC_RESOLVERS: ReadonlySet<string> = new Set(['1.1.1.1', '8.8.8.8', '8.8.4.4', '9.9.9.9']);

const IPV4 = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?!\w)/g;
// A name after a single `/` is a file in a path (`scripts/deploy.app`); after `//` it is a URL's host.
const DOMAIN = /(?<![\w@.-])(?<!(?:^|[^/])\/)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,}))(?![\w-]|\.[a-z0-9])/gi;
const URL = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const HOST_PORT = /(?<![\w.-])(?<!(?:^|[^/])\/)(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,}):(\d{1,5})(?!\d)/gi;
const PORT_WORD = /\bport\s*:?\s*(\d{1,5})(?!\d)/gi;
// `listens on 3300`, `binds to :8100`; a version, date or address after the verb is not a port.
const LISTEN_ON = /\b(?:listen(?:s|ing)?|bind(?:s|ing)?|bound|serve[sd]?|serving)\s+(?:on|to|at)\s+:?(\d{2,5})(?![\d.:/-]\d|[\w.-]*\w)/gi;
const ENV_TICKED = /`([A-Z][A-Z0-9_]{2,})`/g;
const ENV_ASSIGNED = /(?<![\w$])([A-Z][A-Z0-9_]{2,})=/g;
const PATH = /(?<![\w.:/~-])(~\/[\w.@%+-]+(?:\/[\w.@%+-]+)*|\/([\w.@%+-]+)(?:\/[\w.@%+-]+)+)/g;
const FENCE = /^\s*(```|~~~)\s*([\w-]*)/;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

/**
 * Infra values a doc line mentions; ignores loopback, unspecified, link-local, multicast, netmasks, CIDR,
 * documentation ranges, public DNS resolvers and version strings, which never name a real host.
 */
function ipsIn(line: string): string[] {
  const ips: string[] = [];
  for (const m of line.matchAll(IPV4)) {
    const ip = m[1] ?? '';
    const after = line.slice((m.index ?? 0) + ip.length);
    const octets = ip.split('.').map(Number);
    if (octets.some((o) => o > 255) || /^(?:\/|-|\.\d)/.test(after)) continue;
    // `version 2.1.0.4`, `"version": "2.1.0.4"`; not `@`, since `root@10.1.2.3` is how docs name a host.
    if (/\b(?:version|ver|release|build)["']?\s*[:=]?\s*["']?$/i.test(line.slice(0, m.index ?? 0))) continue;
    // Loopback, unspecified, link-local, multicast and netmasks (255.255.255.0) name no host.
    if (octets[0] === 127 || octets[0] === 0 || (octets[0] ?? 0) >= 224 || (octets[0] === 169 && octets[1] === 254)) continue;
    if (/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip)) continue;
    if (PUBLIC_RESOLVERS.has(ip)) continue;
    ips.push(ip);
  }
  return ips;
}

function domainsIn(line: string): string[] {
  return [...line.matchAll(DOMAIN)].filter((m) => TLDS.has((m[2] ?? '').toLowerCase())).map((m) => (m[1] ?? '').toLowerCase());
}

function portsIn(line: string): string[] {
  const ports = portsInDocLine(line);
  for (const m of line.matchAll(HOST_PORT)) {
    const host = m[1] ?? '';
    const isHost = host === 'localhost' || /^\d/.test(host) || TLDS.has(host.split('.').pop()?.toLowerCase() ?? '');
    if (isHost && m[2]) ports.push(m[2]);
  }
  for (const m of line.matchAll(PORT_WORD)) if (m[1]) ports.push(m[1]);
  for (const m of line.matchAll(LISTEN_ON)) if (m[1]) ports.push(m[1]);
  return ports.filter(isPort);
}

function envNamesIn(line: string): string[] {
  // Backticked names need an underscore so `GET` or `API` stay words.
  const ticked = [...line.matchAll(ENV_TICKED)].map((m) => m[1] ?? '').filter((n) => n.includes('_'));
  return [...ticked, ...[...line.matchAll(ENV_ASSIGNED)].map((m) => m[1] ?? '')];
}

function pathsIn(line: string): string[] {
  return [...line.matchAll(PATH)]
    .filter((m) => m[2] === undefined || FS_ROOTS.has(m[2]))
    .map((m) => (m[1] ?? '').replace(/[.,]+$/, ''));
}

function urlsIn(line: string): string[] {
  return [...line.matchAll(URL)].map((m) => m[0].replace(/[.,;:]+$/, ''));
}

/** Column index of a markdown table header cell that says "port", or -1. */
function portColumn(header: string): number {
  return cells(header).findIndex((c) => /^port$/i.test(c));
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
}

export function extractMentions(source: SourceFile, text: string): Mention[] {
  const mentions: Mention[] = [];
  const lines = text.split('\n');
  let fence: string | null = null;
  let shell = false;
  let tablePortColumn = -1;
  lines.forEach((raw, i) => {
    const lineText = raw.trim();
    const add = (attribute: Attribute, values: string[]) => {
      for (const value of new Set(values)) {
        mentions.push({ attribute, value, at: { path: source.path, line: i + 1 }, lineText, kind: source.kind, scope: source.scope, agent: source.agent });
      }
    };
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1] ?? '```';
        shell = SHELL_LANGS.has((fenceMatch[2] ?? '').toLowerCase());
      } else if (fenceMatch[1] === fence) fence = null;
      return;
    }
    if (lineHasSecret(raw)) return;

    if (fence === null && lineText.startsWith('|')) {
      const next = lines[i + 1]?.trim() ?? '';
      if (tablePortColumn < 0 && /^\|?\s*:?-{3,}/.test(next)) {
        tablePortColumn = portColumn(lineText);
        return;
      }
      if (tablePortColumn >= 0 && !/^\|?\s*:?-{3,}/.test(lineText)) {
        const cell = cells(lineText)[tablePortColumn] ?? '';
        if (/^\d{1,5}$/.test(cell) && isPort(cell)) add('port', [cell]);
      }
    } else if (fence === null) {
      tablePortColumn = -1;
    }

    add('ip', ipsIn(raw));
    add('domain', domainsIn(raw));
    add('url', urlsIn(raw));
    add('port', portsIn(raw));
    add('env', envNamesIn(raw));
    add('path', pathsIn(raw));
    if (fence !== null && shell && lineText && !lineText.startsWith('#')) add('command', [lineText.replace(/^\$\s+/, '')]);
  });
  return dedupe(mentions);
}

function dedupe(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.at.line}\0${m.attribute}\0${m.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
