import { parse as parseToml } from 'smol-toml';
import { type FormatParser, lineOf, type ParsedFact } from '../parsed.js';

export const parseFly: FormatParser = (text) => {
  const config = parseToml(text) as { app?: unknown; http_service?: { internal_port?: unknown }; services?: { internal_port?: unknown }[] };
  const app = typeof config.app === 'string' ? config.app : undefined;
  const ports = [config.http_service?.internal_port, ...(Array.isArray(config.services) ? config.services.map((s) => s.internal_port) : [])];
  const facts: ParsedFact[] = ports
    .filter((p): p is number => typeof p === 'number')
    .map((p) => ({ attribute: 'port', value: String(p), line: lineOf(text, String(p)), app }));
  return { apps: app ? [app] : [], facts, corpus: app ? [app] : [] };
};
