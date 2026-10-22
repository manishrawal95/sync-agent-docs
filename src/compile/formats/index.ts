import type { AgentFormat } from '../../types.js';
import type { AgentCompiler } from '../content.js';
import { agents } from './agents.js';
import { claude } from './claude.js';
import { copilot } from './copilot.js';
import { cursor } from './cursor.js';
import { gemini } from './gemini.js';

export const COMPILERS: readonly AgentCompiler[] = [claude, agents, gemini, cursor, copilot];

/** The files compile writes, relative to a repo root. */
export const COMPILED_FILES: readonly string[] = COMPILERS.map((c) => c.file);

export function compilerFor(format: AgentFormat): AgentCompiler {
  const c = COMPILERS.find((x) => x.format === format);
  if (!c) throw new Error(`compile: no compiler for agent format ${format}. Fix agentFormats in sync-agent-docs.json.`);
  return c;
}
