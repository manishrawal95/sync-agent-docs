export type SourceKind = 'claim' | 'truth';
export type Scope = 'repo' | 'machine';
export type AgentFormat = 'claude' | 'agents' | 'gemini' | 'cursor' | 'copilot';
export const AGENT_FORMATS: readonly AgentFormat[] = ['claude', 'agents', 'gemini', 'cursor', 'copilot'];
export type SourceFormat =
  | 'markdown' | 'package-json' | 'wrangler' | 'vercel-json' | 'vercel-project'
  | 'pm2' | 'compose' | 'fly' | 'procfile' | 'env' | 'git-config'
  | 'ssh-config' | 'crontab' | 'launch-agent' | 'shell-rc' | 'gh-hosts';
export interface SourceFile {
  path: string; realPath: string; repo: string | null;
  kind: SourceKind; scope: Scope; format: SourceFormat; agent: AgentFormat | null;
}
export interface SkippedFile { path: string; reason: 'too-large' | 'binary' | 'unreadable' | 'not-utf8' | 'linked-worktree'; note?: string }
export interface RepoInfo { name: string; path: string }
export interface Location { path: string; line: number }
export type EntityKind = 'project' | 'app' | 'host' | 'domain';
export interface Entity {
  id: string; kind: EntityKind; names: string[];
  identifiers: Partial<Record<'ip' | 'domain' | 'vercelProjectId' | 'gitRemote', string>>;
  /** Links by name only to lines under this folder (a generic app's repo): `web` or `api` names too much prose elsewhere. */
  within?: string;
}
export type Attribute = 'port' | 'ip' | 'domain' | 'url' | 'env' | 'command' | 'path';
export interface Mention {
  attribute: Attribute; value: string; at: Location; lineText: string;
  kind: SourceKind; scope: Scope; agent: AgentFormat | null;
}
export interface Fact extends Mention { entityId: string | null }
export interface TruthResult { entities: Entity[]; facts: Fact[]; corpus: Set<string>; skipped: SkippedFile[] }
export type FindingType = 'conflict' | 'global-local' | 'possible-conflict' | 'stale' | 'duplicated' | 'secret';
export interface ValueGroup { value: string; at: Location[]; truthBacked: boolean }
export interface Finding {
  type: FindingType; message: string;
  entityId?: string; attribute?: Attribute; values?: ValueGroup[];
  at?: Location[]; tokens?: number; masked?: string;
}
export interface ScanResult {
  root: string; scannedAt: string; repos: RepoInfo[];
  machineFilesRead: string[]; skipped: SkippedFile[];
  agentFileCounts: Record<AgentFormat, number>;
  entities: Entity[]; facts: Fact[]; findings: Finding[];
  agentTokens: number; duplicatedTokens: number; score: number;
}
