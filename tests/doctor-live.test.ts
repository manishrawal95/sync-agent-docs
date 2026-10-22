import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_IDS, type LiveTarget } from '../src/doctor/types.js';
import type { StoreEntity, StoreFact } from '../src/store/types.js';
import { applied, check } from './helpers/doctor.js';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: number }
const closers: (() => Promise<unknown>)[] = [];
const closing = (server: Server | ReturnType<typeof createTcpServer>) => () => new Promise((r) => server.close(r));
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** An HTTP server on 127.0.0.1 that records each request and answers with `status`, or never answers. */
async function http(status: number | 'hang', headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = 0;
    req.on('data', (c: Buffer) => (body += c.length));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (status !== 'hang') res.writeHead(status, headers).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => (server.closeAllConnections(), closing(server)()));
  return { seen, port: (server.address() as AddressInfo).port };
}

async function tcp() {
  const server = createTcpServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(closing(server));
  return (server.address() as AddressInfo).port;
}

/** A TCP server that starts an HTTP answer and then sends one header line every 100 ms, forever. */
async function drip() {
  const timers: NodeJS.Timeout[] = [];
  const sockets: Socket[] = [];
  const server = createTcpServer((s) => {
    sockets.push(s);
    s.on('error', () => undefined);
    s.write('HTTP/1.1 200 OK\r\n');
    timers.push(setInterval(() => s.write('x-drip: 1\r\n'), 100));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => (timers.forEach(clearInterval), sockets.forEach((s) => s.destroy()), closing(server)()));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: bound once, then closed. */
async function closedPort() {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

const fact = (entityId: string, attribute: StoreFact['attribute'], value: string): StoreFact => ({ entityId, attribute, value, sources: [], status: 'verified' });
const entity = (id: string, network?: string): StoreEntity => ({ id, kind: 'host', names: [id], identifiers: {}, notes: '', ...(network ? { network } : {}) }) as StoreEntity;

/** A store holding only these targets, with every check but live disabled so nothing else runs. */
async function setup(entities: StoreEntity[], facts: StoreFact[]) {
  const a = await applied({ answerAll: true });
  await writeFile(join(a.store, 'store', 'entities.json'), JSON.stringify({ schema: 1, entities }));
  const factsPath = join(a.store, 'store', 'facts.json');
  await writeFile(factsPath, JSON.stringify({ ...JSON.parse(await readFile(factsPath, 'utf8')), facts }));
  await mkdir(join(a.root, '.sync-agent-docs'), { recursive: true });
  await writeFile(join(a.root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: CHECK_IDS.filter((id) => id !== 'live') }));
  return a;
}

describe('doctor --live', () => {
  it('checks recorded targets with one bare HEAD each, and lists them first', async () => {
    const web = await http(200);
    const port = await tcp();
    const { doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://127.0.0.1:${web.port}/health`), fact('host:lab', 'ip', '127.0.0.1'), fact('host:lab', 'port', String(port))]);
    let listed: LiveTarget[] = [];
    let seenWhenListed = -1;
    const r = await doctor({ live: true, onLiveTargets: (t) => ((listed = t), (seenWhenListed = web.seen.length)) });
    expect(seenWhenListed).toBe(0);
    expect(listed.map((t) => t.target)).toEqual([`http://127.0.0.1:${web.port}/health`, `127.0.0.1:${port}`]);
    expect(r.live?.map((t) => [t.kind, t.result])).toEqual([['http', 'ok'], ['tcp', 'ok']]);
    expect(check(r, 'live')).toEqual({ id: 'live', status: 'clean', findings: [] });
    expect(web.seen).toHaveLength(1);
    expect(web.seen[0]).toMatchObject({ method: 'HEAD', url: '/', body: 0 });
    expect(web.seen[0]?.headers['user-agent']).toBe('sync-agent-docs-doctor');
    expect(Object.keys(web.seen[0]?.headers ?? {}).filter((h) => ['authorization', 'cookie'].includes(h))).toEqual([]);
  });

  it('requests only / on the recorded origin, so a path such as a cron route is never run', async () => {
    const web = await http(200);
    const { doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://127.0.0.1:${web.port}/api/cron/booking-reminders`)]);
    const r = await doctor({ live: true });
    expect(web.seen.map((s) => [s.method, s.url])).toEqual([['HEAD', '/']]);
    expect(r.live?.[0]?.target).toBe(`http://127.0.0.1:${web.port}/api/cron/booking-reminders`);
  });

  it('reports a redirect without following it', async () => {
    const web = await http(302, { location: 'http://127.0.0.1:1/next' });
    const { doctor } = await setup([entity('host:lab', 'tailnet')], [fact('host:lab', 'url', `http://127.0.0.1:${web.port}/`)]);
    const r = await doctor({ live: true });
    expect(r.live?.[0]).toMatchObject({ result: 'ok', detail: expect.stringContaining('302') });
    expect(web.seen).toHaveLength(1);
  });

  it('a closed port and a server that never answers are drift', async () => {
    const hung = await http('hang');
    const closed = await closedPort();
    const { doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://127.0.0.1:${hung.port}/`), fact('host:lab', 'ip', '127.0.0.1'), fact('host:lab', 'port', String(closed))]);
    const r = await doctor({ live: true, timeoutMs: 200 });
    const c = check(r, 'live');
    expect(c.status).toBe('drift');
    expect(c.findings.map((f) => f.key)).toEqual([`live:http:http://127.0.0.1:${hung.port}/`, `live:tcp:127.0.0.1:${closed}`]);
    expect(r.live?.map((t) => t.detail)).toEqual([expect.stringContaining('timed out'), expect.stringContaining('refused')]);
  });

  it('a server that drips headers fails within the timeout instead of holding doctor open', async () => {
    const port = await drip();
    const { doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://127.0.0.1:${port}/`)]);
    const started = Date.now();
    const r = await doctor({ live: true, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.live?.[0]).toMatchObject({ result: 'failed', detail: expect.stringContaining('300 ms') });
  }, 10_000);

  it('a private or loopback address with no network mark is skipped, never contacted', async () => {
    const web = await http(200);
    const { doctor } = await setup([entity('host:lab'), entity('host:name')], [fact('host:lab', 'url', `http://127.0.0.1:${web.port}/`), fact('host:name', 'url', `http://localhost:${web.port}/`)]);
    const r = await doctor({ live: true });
    expect(web.seen).toHaveLength(0);
    expect(r.live?.map((t) => t.result)).toEqual(['skipped', 'skipped']);
    const c = check(r, 'live');
    expect(c.status).toBe('clean');
    expect(c.findings.every((f) => f.level === 'note' && f.message.includes('"network": "local"'))).toBe(true);
  });

  it('an IPv4-mapped IPv6 literal for loopback is skipped, never contacted', async () => {
    const web = await http(200);
    const { doctor } = await setup([entity('host:lab')], [fact('host:lab', 'url', `http://[::ffff:127.0.0.1]:${web.port}/`)]);
    const r = await doctor({ live: true });
    expect(web.seen).toHaveLength(0);
    expect(r.live?.[0]).toMatchObject({ result: 'skipped', detail: expect.stringContaining('not a public address') });
  });

  it('a URL with credentials or a query is requested and shown as scheme, host and path only', async () => {
    const web = await http(200);
    const { root, doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://admin:p4ssw0rd@127.0.0.1:${web.port}/x?token=t0kenvalue#frag`)]);
    let listed = '';
    const r = await doctor({ live: true, onLiveTargets: (t) => (listed = JSON.stringify(t)) });
    expect(web.seen).toEqual([expect.objectContaining({ url: '/' })]);
    expect(web.seen[0]?.headers.authorization).toBeUndefined();
    for (const text of [listed, JSON.stringify(r), await readFile(join(root, '.sync-agent-docs', 'doctor.json'), 'utf8')]) {
      for (const bad of ['admin', 'p4ssw0rd', 't0kenvalue', 'frag']) expect(text).not.toContain(bad);
    }
    expect(r.live?.[0]?.target).toBe(`http://127.0.0.1:${web.port}/x`);
  });

  it('without --live nothing is contacted and there is no live check', async () => {
    const web = await http(200);
    const { doctor } = await setup([entity('host:lab', 'local')], [fact('host:lab', 'url', `http://127.0.0.1:${web.port}/`)]);
    const r = await doctor();
    expect(web.seen).toHaveLength(0);
    expect(r.live).toBeNull();
    expect(r.checks.map((c) => c.id)).not.toContain('live');
  });

  it('a network mark other than local or tailnet is an error naming the file', async () => {
    const { doctor } = await setup([entity('host:lab', 'lan')], []);
    await expect(doctor()).rejects.toThrow(/doctor: .*entities\.json: host:lab has network "lan", which is not local or tailnet/);
  });
});
