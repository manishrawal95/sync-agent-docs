import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, connect, isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import { mapLimited } from '../pool.js';
import { printable } from '../report/terminal.js';
import type { Store } from '../store/types.js';
import type { Check, Found, LiveTarget } from './types.js';

export const LIVE_TIMEOUT_MS = 3000;
export const LIVE_CONCURRENCY = 4;
const NETWORKS = ['local', 'tailnet'];

/** A target with what probing it needs; only `shown` is ever printed. */
interface Planned { shown: LiveTarget; host: string; port: number; scheme?: 'http' | 'https'; probeKey: string }
type Resolved = { address: string; family: number }[];

/** IANA special-purpose IPv4 ranges (RFC 6890 and later): never contacted for an unmarked entity. */
const SPECIAL_V4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) SPECIAL_V4.addSubnet(net, bits, 'ipv4');

/** Global unicast IPv6 is 2000::/3; these parts of it are not global, or hide an IPv4 address behind a translator. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const SPECIAL_V6 = new BlockList();
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) SPECIAL_V6.addSubnet(net, bits, 'ipv6');

/** The 16 bytes of an IPv6 address, or null when `address` is not one. */
function v6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.split('%')[0] ?? '';
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const part = (x: string) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  const hi = part(head);
  const lo = tail === undefined ? [] : part(tail);
  const words = [...hi, ...new Array<number>(8 - hi.length - lo.length).fill(0), ...lo];
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/**
 * Whether doctor may contact `address` for an entity with no network mark: global unicast only.
 * An IPv4-mapped address is judged by the IPv4 address inside it. NAT64 (64:ff9b::/96,
 * 64:ff9b:1::/48) and 6to4 (2002::/16) are refused whatever they carry, so a translator can never
 * be used to reach a private address.
 */
export function isGlobal(address: string): boolean {
  if (isIP(address) === 4) return !SPECIAL_V4.check(address, 'ipv4');
  const bytes = v6Bytes(address);
  if (!bytes) return false;
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return isGlobal(bytes.slice(12).join('.'));
  return GLOBAL_V6.check(address, 'ipv6') && !SPECIAL_V6.check(address, 'ipv6');
}

/** The first address in a name's answers that is not global, '(no address)' for an empty answer, or null when all are. */
export function notGlobal(addresses: { address: string; family: number }[]): string | null {
  if (!addresses.length) return '(no address)';
  return addresses.find((a) => !isGlobal(a.address))?.address ?? null;
}

/** Throws when an entity's hand-set `network` is not one doctor knows, naming the file to fix. */
export function checkNetworkMarks(store: Store, storeDir: string): void {
  for (const e of store.entities) {
    if (e.network !== undefined && !NETWORKS.includes(e.network)) {
      throw new Error(`doctor: ${join(storeDir, 'store', 'entities.json')}: ${e.id} has network ${JSON.stringify(e.network)}, which is not local or tailnet. Set it to one of those or remove it, then run doctor again.`);
    }
  }
}

/**
 * A URL as doctor shows it: scheme, host, port and path, never credentials, query or fragment.
 * Only `/` on its origin is requested: a HEAD to the recorded path can run that route's GET handler.
 */
function planUrl(value: string, entityId: string): Planned | LiveTarget {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    // Reported as a skipped target. The value is not shown: a string that is not a URL could be anything.
    return { kind: 'http', target: '(not a valid URL)', entityId, result: 'skipped', detail: `a url fact of ${entityId} is not a valid URL, so it was not checked` };
  }
  const scheme = u.protocol.slice(0, -1);
  const target = `${u.protocol}//${u.host}${u.pathname}`;
  if (scheme !== 'http' && scheme !== 'https') return { kind: 'http', target, entityId, result: 'skipped', detail: 'only http and https URLs are checked' };
  const port = Number(u.port || (scheme === 'https' ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return { shown: { kind: 'http', target, entityId }, host, port, scheme, probeKey: `http: ${scheme}://${host}:${port}` };
}

/** Every target the store records: url and domain facts as HEAD requests, each ip with each port as a TCP connect. */
export function liveTargets(store: Store): { planned: Planned[]; skipped: LiveTarget[] } {
  const planned: Planned[] = [];
  const skipped: LiveTarget[] = [];
  const seen = new Set<string>();
  const add = (p: Planned | LiveTarget) => {
    const shown = 'shown' in p ? p.shown : p;
    const id = `${shown.kind} ${shown.target} ${shown.entityId}`;
    if (seen.has(id)) return;
    seen.add(id);
    if ('shown' in p) planned.push(p);
    else skipped.push(p);
  };
  for (const e of store.entities) {
    const values = (attribute: string) => store.facts.filter((f) => f.entityId === e.id && f.attribute === attribute).map((f) => f.value);
    for (const url of values('url')) add(planUrl(url, e.id));
    for (const domain of [...values('domain'), ...(e.identifiers.domain ? [e.identifiers.domain] : [])]) add(planUrl(`https://${domain}/`, e.id));
    const ports = values('port').map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    for (const ip of [...values('ip'), ...(e.identifiers.ip ? [e.identifiers.ip] : [])]) {
      if (!isIP(ip)) continue;
      for (const port of ports) add({ shown: { kind: 'tcp', target: `${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`, entityId: e.id }, host: ip, port, probeKey: `tcp: ${ip}:${port}` });
    }
  }
  return { planned, skipped };
}

type Outcome = Pick<LiveTarget, 'result' | 'detail'>;
const ok = (detail: string): Outcome => ({ result: 'ok', detail });
const failed = (detail: string): Outcome => ({ result: 'failed', detail });

function reason(err: NodeJS.ErrnoException): string {
  if (err.code === 'ECONNREFUSED') return 'connection refused';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'the name does not resolve';
  return err.code ? `${err.code}: ${err.message}` : err.message;
}

/** Thrown by `resolveOnce` when the deadline passes first, so callers need not read the message. */
class LookupTimeout extends Error {}

/** Every address `host` resolves to, looked up once: the caller checks them all and connects to the first. */
async function resolveOnce(host: string, timeoutMs: number, resolve: (host: string) => Promise<Resolved>): Promise<Resolved> {
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LookupTimeout(`resolving ${host} timed out after ${timeoutMs} ms`)), timeoutMs)));
  try {
    return await Promise.race([resolve(host), late]);
  } finally {
    clearTimeout(timer);
  }
}

function headRequest(t: Planned, address: string, family: number, left: number, timeoutMs: number): Promise<Outcome> {
  const pinned: LookupFunction = (_host, options, cb) => (options.all ? cb(null, [{ address, family }]) : cb(null, address, family));
  return new Promise((done) => {
    let settled = false;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      done(o);
    };
    const req = (t.scheme === 'https' ? https : http).request({ host: t.host, port: t.port, path: '/', method: 'HEAD', headers: { 'user-agent': 'sync-agent-docs-doctor' }, agent: false, lookup: pinned, timeout: left }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      if (status >= 500) finish(failed(`answered ${status}`));
      else if (status >= 300 && status < 400) finish(ok(`answered ${status}, a redirect doctor does not follow`));
      else finish(ok(`answered ${status}`));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => finish(failed(reason(err))));
    // `timeout` above only fires when the socket goes idle; a server that keeps trickling bytes needs a hard stop.
    const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), left);
    req.end();
  });
}

function tcpConnect(address: string, port: number, left: number, timeoutMs: number): Promise<Outcome> {
  return new Promise((done) => {
    const socket = connect({ host: address, port, timeout: left });
    const deadline = setTimeout(() => socket.destroy(new Error(`timed out after ${timeoutMs} ms`)), left);
    const finish = (o: Outcome) => (clearTimeout(deadline), done(o));
    socket.once('connect', () => (socket.destroy(), finish(ok('accepted a connection'))));
    socket.once('timeout', () => socket.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    socket.once('error', (err) => finish(failed(reason(err))));
  });
}

/** One probe of a target, with `deadline` (epoch ms) covering the lookup and the connect together. */
async function probe(t: Planned, local: boolean, deadline: number, timeoutMs: number, resolve: (host: string) => Promise<Resolved>): Promise<Outcome> {
  const left = () => deadline - Date.now();
  const timedOut = () => failed(`timed out after ${timeoutMs} ms`);
  if (left() <= 0) return timedOut();
  let addresses;
  try {
    addresses = await resolveOnce(t.host, left(), resolve);
  } catch (err) {
    return err instanceof LookupTimeout ? timedOut() : failed(reason(err as NodeJS.ErrnoException));
  }
  const bad = local ? null : notGlobal(addresses);
  if (bad !== null) {
    const via = t.host === bad ? '' : ` resolves to ${bad}, which`;
    return { result: 'skipped', detail: `${t.host}${via} is not a public address, so it was not contacted` };
  }
  const resolved = addresses[0];
  if (!resolved) return failed('the name does not resolve');
  if (left() <= 0) return timedOut();
  return t.shown.kind === 'tcp' ? tcpConnect(resolved.address, t.port, left(), timeoutMs) : headRequest(t, resolved.address, resolved.family, left(), timeoutMs);
}

/** The list printed before any lookup or connection, so the owner sees what --live will touch. */
export function renderLiveTargets(targets: LiveTarget[]): string {
  if (!targets.length) return 'doctor --live: the store records no network targets.';
  const lines = targets.map((t) => `  ${t.kind === 'http' ? 'HEAD / on' : 'TCP'} ${printable(t.target)} (${printable(t.entityId)})${t.result === 'skipped' ? `, skipped: ${printable(t.detail ?? '')}` : ''}`);
  return [`doctor --live: checking ${targets.length} targets from the store (private addresses are skipped unless the entity is marked local or tailnet):`, ...lines].join('\n');
}

export interface LiveOptions { timeoutMs?: number; resolve?: (host: string) => Promise<Resolved>; onLiveTargets?: (targets: LiveTarget[]) => void }

/**
 * The live check. `onLiveTargets` gets the full list before any lookup or connection; the probed
 * targets, with results, are left in `results` for the run's report.
 */
export function liveCheck(opts: LiveOptions): Check & { results: LiveTarget[] } {
  const results: LiveTarget[] = [];
  return {
    id: 'live',
    results,
    async run(ctx) {
      const { planned, skipped } = liveTargets(ctx.store);
      opts.onLiveTargets?.([...planned.map((p) => ({ ...p.shown })), ...skipped]);
      const local = new Set(ctx.store.entities.filter((e) => e.network).map((e) => e.id));
      const timeoutMs = opts.timeoutMs ?? LIVE_TIMEOUT_MS;
      const resolve = opts.resolve ?? ((host: string) => lookup(host, { all: true, order: 'verbatim' }));
      // One probe per origin or ip:port and contact mode; every planned target in the group gets its outcome.
      const groups = new Map<string, { first: Planned; local: boolean; outcome?: Outcome }>();
      const groupOf = planned.map((p) => {
        const isLocal = local.has(p.shown.entityId);
        const key = `${p.probeKey}|${isLocal}`;
        if (!groups.has(key)) groups.set(key, { first: p, local: isLocal });
        return key;
      });
      await mapLimited([...groups.values()], LIVE_CONCURRENCY, async (g) => {
        g.outcome = await probe(g.first, g.local, Date.now() + timeoutMs, timeoutMs, resolve);
      });
      // The outcome is shared by the group; the advice to mark an entity names each target's own.
      const withAdvice = (t: LiveTarget): LiveTarget => (t.result === 'skipped' ? { ...t, detail: `${t.detail}. To check it, add "network": "local" (or "tailnet") to ${t.entityId} in store/entities.json` } : t);
      results.push(...planned.map((p, i) => withAdvice({ ...p.shown, ...groups.get(groupOf[i] ?? '')?.outcome })), ...skipped);
      const out: Found[] = [];
      for (const t of results) {
        const key = `live:${t.kind}:${t.target}:${t.entityId}`;
        if (t.result === 'failed') out.push({ key, message: `${t.target} (${t.entityId}): ${t.detail ?? 'failed'}. Check that it is up, or fix the store if it moved.` });
        else if (t.result === 'skipped') out.push({ key, level: 'note', message: `${t.target} (${t.entityId}): ${t.detail ?? 'skipped'}.` });
      }
      return out;
    },
  };
}
