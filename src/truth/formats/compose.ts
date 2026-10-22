import { parse as parseYaml } from 'yaml';
import { type FormatParser, isPort, lineOf, type ParsedFact } from '../parsed.js';

function hostPort(spec: unknown): string | null {
  if (typeof spec === 'number') return String(spec);
  if (spec && typeof spec === 'object' && 'published' in spec) return String((spec as { published: unknown }).published);
  if (typeof spec !== 'string') return null;
  const parts = spec.replace(/\/(tcp|udp)$/, '').split(':');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : (parts[0] ?? null);
}

function envNames(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment.filter((e): e is string => typeof e === 'string').map((e) => e.split('=')[0] ?? '').filter(Boolean);
  }
  return environment && typeof environment === 'object' ? Object.keys(environment) : [];
}

export const parseCompose: FormatParser = (text) => {
  const doc = parseYaml(text) as { services?: Record<string, { ports?: unknown; environment?: unknown; container_name?: unknown }> } | null;
  const apps: string[] = [];
  const facts: ParsedFact[] = [];
  for (const [app, service] of Object.entries(doc?.services ?? {})) {
    apps.push(app);
    const from = lineOf(text, `${app}:`);
    for (const spec of Array.isArray(service?.ports) ? service.ports : []) {
      const port = hostPort(spec);
      if (port && isPort(port)) facts.push({ attribute: 'port', value: port, line: lineOf(text, port, from), app });
    }
    for (const name of envNames(service?.environment)) {
      facts.push({ attribute: 'env', value: name, line: lineOf(text, name, from), app });
    }
  }
  return { apps, facts, corpus: apps };
};
