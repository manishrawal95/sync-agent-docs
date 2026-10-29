import type { Finding, SourceFile } from '../types.js';

const KNOWN: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{60,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk_live_[A-Za-z0-9]{20,}/,
  // Anthropic (sk-ant-api03-, sk-ant-admin01-) and OpenAI project and service-account keys. The body must
  // be long and mix letters and digits, so `sk-proj-abc` or `sk-ant-api03-xxxx...` in a doc is not flagged.
  /(?<![\w-])sk-ant-[a-z]+\d{2}-(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/,
  /(?<![\w-])sk-(?:proj|svcacct)-(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
// `host:5173/@vite` is a port and a path, not a password, and a password may still hold `/`. Digits
// and a `/` are a port when a host comes before them, or when only path folders follow.
const PORT_START = /^\d{1,5}\//;
const PATH_ONLY = /^\d{1,5}\/(?:[^/]*\/)*$/;
const HOST = /^(?:localhost|[\w-]+(?:\.[\w-]+)+|\[[0-9a-f:]+\])$/i;
const portPath = (user: string, rest: string): boolean => PATH_ONLY.test(rest) || (PORT_START.test(rest) && HOST.test(user));
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^\s"'`]+)/g;
// `api_key: value` in YAML. Prose and headings use colons freely, so it counts only for a secret name.
const COLON_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']?([^\s"'`]+)/g;
// IDs shaped like a commit SHA, a SHA-256 digest or a UUID, skipped only under a name that says
// ID and not secret: an unknown name fails closed.
const ID_SHAPE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ID_NAME = /sha|commit|revision|digest|uuid|guid|hash|checksum|(?:^|_)id$/i;
const CAMEL_ID = /[a-z]Id$/;
const SECRET_NAME = /key|secret|token|pass|pwd|auth|cred|private|signing|signature|(?:^|_)sig(?:_|$)|salt|hmac|jwt|session|cookie|bearer|cipher|encrypt|webhook|nonce/i;
// A subresource-integrity hash names public content.
const INTEGRITY = /^sha(?:256|384|512)-/;
// Values a doc uses as a stand-in, never a real credential.
const PLACEHOLDER = /^(?:<.*>|\$\{?.*|\*+|x+|\.\.\.|password|pass|secret|changeme|your[-_].*)$/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/**
 * A high-entropy assigned value. Paths, URLs and anything with characters a token
 * does not use are left alone: precision over recall.
 */
function looksLikeToken(value: string): boolean {
  return value.length >= 20
    && /^[A-Za-z0-9+/_\-.=]+$/.test(value) && !/^[/~.]/.test(value)
    && /\d/.test(value) && /[A-Za-z]/.test(value)
    && !PLACEHOLDER.test(value)
    && entropy(value) >= 3.5;
}

/**
 * `scheme://user:password@` credentials, as `[user, password]`. A forward scan, not a regex: a
 * regex with unbounded groups is quadratic on a long line of `://x:` with no `@`, and a bounded one
 * misses a long password. The stop after each password is found once and reused, so the scan is linear.
 */
function* urlCredentials(line: string): Generator<[string, string]> {
  const stopAt = (from: number): number => {
    for (let i = from; i < line.length; i++) if (line[i] === '@' || /\s/.test(line[i] ?? '')) return i;
    return line.length;
  };
  let stop = -1;
  for (let at = line.indexOf('://'); at !== -1; at = line.indexOf('://', at + 3)) {
    let colon = at + 3;
    while (colon < line.length && !/[:/\s]/.test(line[colon] ?? '')) colon++;
    if (line[colon] !== ':' || colon === at + 3) continue;
    if (stop <= colon) stop = stopAt(colon + 1);
    if (line[stop] === '@' && stop > colon + 1) yield [line.slice(at + 3, colon), line.slice(colon + 1, stop)];
  }
}

const firstPart = (value: string): string => value.split(/[&;]/, 1)[0] ?? '';

/** The secret on a line, or null. Only ever passed to `mask`. */
function secretIn(line: string): string | null {
  for (const re of KNOWN) {
    const m = re.exec(line);
    if (m) return m[0];
  }
  for (const [user, cred] of urlCredentials(line)) if (!PLACEHOLDER.test(cred) && !portPath(user, cred)) return cred;
  const assignments = [...line.matchAll(ASSIGNMENT)];
  for (const m of line.matchAll(COLON_ASSIGNMENT)) if (SECRET_NAME.test(m[1] ?? '') && looksLikeToken(firstPart(m[2] ?? ''))) assignments.push(m);
  for (const [, name = '', rawValue = ''] of assignments) {
    // `?token=X&env=prod` and `token=X;env=prod`: the value ends at the separator.
    const value = firstPart(rawValue);
    if (!value) continue;
    const idName = ID_NAME.test(name) || CAMEL_ID.test(name);
    // A UUID is too regular to pass the entropy test, so a secret name is what flags it.
    if (ID_SHAPE.test(value) && SECRET_NAME.test(name) && !idName) return value;
    if (!looksLikeToken(value)) continue;
    if (!SECRET_NAME.test(name) && (INTEGRITY.test(value) || (ID_SHAPE.test(value) && idName))) continue;
    return value;
  }
  return null;
}

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * `text` with every private key block, BEGIN to END, blanked line for line. Only the BEGIN line looks
 * like a secret, so without this the key body would pass through as ordinary text.
 */
export function blankKeyBlocks(text: string): string {
  let open = false;
  return text.split('\n').map((line) => {
    if (!open && KEY_BEGIN.test(line)) open = !KEY_END.test(line.slice(line.search(KEY_BEGIN)));
    else if (open) open = !KEY_END.test(line);
    else return line;
    return '';
  }).join('\n');
}

export function lineHasSecret(line: string): boolean {
  return secretIn(line) !== null;
}

/** First 4 characters (fewer for short values, never more than half) plus an ellipsis. */
export function mask(value: string): string {
  return `${value.slice(0, Math.min(4, Math.floor(value.length / 2)))}…`;
}

/** Plain-text secrets in a claim file. Truth files (.env and the like) are expected to hold them. */
export function findSecrets(source: SourceFile, text: string): Finding[] {
  if (source.kind !== 'claim') return [];
  const findings: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const secret = secretIn(line);
    if (!secret) return;
    findings.push({
      type: 'secret',
      message: `Possible secret in ${source.path} line ${i + 1} (${mask(secret)}). Move it to a secret store and rotate it.`,
      at: [{ path: source.path, line: i + 1 }],
      masked: mask(secret),
    });
  });
  return findings;
}
