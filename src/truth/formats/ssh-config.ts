import type { FormatParser, ParsedHost } from '../parsed.js';

/** One ssh_config line as keyword and value: ssh accepts `Key value`, `Key=value` and `Key = value`. */
function keyValue(line: string): { key: string; value: string } | null {
  const m = /^([^\s=#]+)\s*(?:=\s*|\s+)(.*)$/.exec(line.trim());
  return m?.[1] && m[2] !== undefined ? { key: m[1].toLowerCase(), value: m[2].trim() } : null;
}

/**
 * Each `Host` line becomes one host named by its first non-wildcard pattern, the others kept as aliases,
 * with its `HostName`. Like ssh, the first HostName obtained wins. Nothing else in ~/.ssh is opened.
 */
export const parseSshConfig: FormatParser = (text) => {
  const hosts: ParsedHost[] = [];
  let current: ParsedHost | null = null;
  text.split('\n').forEach((raw, i) => {
    const kv = keyValue(raw);
    if (!kv) return;
    if (kv.key === 'host' || kv.key === 'match') {
      const [alias, ...aliases] = kv.key === 'host' ? kv.value.split(/\s+/).filter((a) => a !== '' && !/[*?!]/.test(a)) : [];
      current = alias ? { alias, aliases, line: i + 1 } : null;
      if (current) hosts.push(current);
    } else if (kv.key === 'hostname' && kv.value && current && current.hostName === undefined) {
      Object.assign(current, { hostName: kv.value.split(/\s+/)[0], line: i + 1 });
    }
  });
  return { hosts, corpus: hosts.flatMap((h) => [h.alias, ...(h.aliases ?? []), ...(h.hostName ? [h.hostName] : [])]) };
};
