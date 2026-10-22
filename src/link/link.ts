import { basename } from 'node:path';
import type { Entity, Fact, Mention } from '../types.js';

// Well-known service ports describe a database or protocol, not the app a line names.
const SERVICE_PORTS = new Set(['22', '80', '443', '3306', '5432', '6379', '27017']);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A markdown table row is about its first cell; anything else is about the whole line. */
function subject(lineText: string): string {
  const row = /^\s*\|([^|]*)\|/.exec(lineText);
  return row ? (row[1] ?? '') : lineText;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatchers(entities: Entity[]): { entity: Entity; patterns: RegExp[] }[] {
  return entities.map((entity) => ({
    entity,
    // An IP name links through identifiers, never by name: it would pull other IPs on the line onto the host.
    // A name inside a path (`~/dev/shop/x`) or a longer name (`shop-api`) is not that entity.
    patterns: entity.names.filter((n) => n.length >= 3 && !IPV4.test(n)).map((n) => new RegExp(`(?<![\\w./-])${escape(n)}(?![\\w/-]|\\.\\w)`, 'i')),
  }));
}

/**
 * Attaches each mention to an entity only when that is unambiguous: an exact IP or
 * domain identifier, or a line that names exactly one entity. Everything else stays
 * unlinked (entityId null), because a wrong link would invent a conflict.
 */
export function linkMentions(mentions: Mention[], entities: Entity[]): Fact[] {
  const byIdentifier = new Map<string, string>();
  for (const e of entities) {
    if (e.identifiers.ip) byIdentifier.set(`ip:${e.identifiers.ip}`, e.id);
    if (e.identifiers.domain) byIdentifier.set(`domain:${e.identifiers.domain.toLowerCase()}`, e.id);
  }
  const matchers = nameMatchers(entities);
  const fileSubject = new Map<string, Entity>();
  for (const e of entities) for (const n of e.names) if (n.length >= 3) fileSubject.set(n.toLowerCase(), e);
  const cache = new Map<string, Entity[]>();
  const named = (lineText: string): Entity[] => {
    let hit = cache.get(lineText);
    if (!hit) {
      hit = matchers.filter((m) => m.patterns.some((p) => p.test(lineText))).map((m) => m.entity);
      cache.set(lineText, hit);
    }
    return hit;
  };

  // Two different ports on one line: which one belongs to the named entity is a guess.
  const portsOnLine = new Map<string, Set<string>>();
  for (const m of mentions) {
    if (m.attribute !== 'port') continue;
    const key = `${m.at.path}\0${m.at.line}`;
    portsOnLine.set(key, (portsOnLine.get(key) ?? new Set()).add(m.value));
  }

  return mentions.map((m) => {
    const direct = m.attribute === 'ip' || m.attribute === 'domain' ? byIdentifier.get(`${m.attribute}:${m.value.toLowerCase()}`) : undefined;
    if (direct) return { ...m, entityId: direct };
    if (m.attribute === 'port' && SERVICE_PORTS.has(m.value)) return { ...m, entityId: null };
    if (m.attribute === 'port' && (portsOnLine.get(`${m.at.path}\0${m.at.line}`)?.size ?? 0) > 1) return { ...m, entityId: null };
    // A repo-scoped app counts as named only on lines inside its repo.
    const names = named(subject(m.lineText)).filter((e) => !e.within || m.at.path.startsWith(`${e.within}/`));
    const only = names.length === 1 ? names[0] : undefined;
    // A file named for an entity (`projects/blog.md`) is about it; naming another there is an aside.
    const about = fileSubject.get(basename(m.at.path).replace(/\.[^.]+$/, '').toLowerCase());
    if (about && only && about !== only) return { ...m, entityId: null };
    if (!only || (m.attribute === 'ip' && only.kind !== 'host')) return { ...m, entityId: null };
    return { ...m, entityId: only.id };
  });
}
