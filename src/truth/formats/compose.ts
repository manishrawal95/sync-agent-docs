import { parse as parseYaml } from 'yaml';
import { escapeRegExp, type FormatParser, isPort, lineOf, type ParsedFact } from '../parsed.js';

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

/**
 * The line of service `app`'s key: a mapping key, quoted or not, at the indentation of the first child
 * of `services:`, so `depends_on: [web]` or `image: web:1.2` in an earlier service is never it.
 */
function serviceLine(text: string, app: string): number {
  const lines = text.split('\n');
  const top = lines.findIndex((l) => /^services\s*:/.test(l));
  const child = lines.slice(top + 1).find((l) => /^\s+[^\s#]/.test(l));
  const indent = /^\s*/.exec(child ?? '')?.[0] ?? '';
  return lineOf(text, new RegExp(`^${indent}(["']?)${escapeRegExp(app)}\\1\\s*:`), top + 2);
}

export const parseCompose: FormatParser = (text) => {
  const doc = parseYaml(text) as { services?: Record<string, { ports?: unknown; environment?: unknown; container_name?: unknown }> } | null;
  const apps: string[] = [];
  const facts: ParsedFact[] = [];
  for (const [app, service] of Object.entries(doc?.services ?? {})) {
    apps.push(app);
    const from = serviceLine(text, app);
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
