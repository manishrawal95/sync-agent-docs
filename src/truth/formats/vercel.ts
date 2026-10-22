import { type FormatParser, hostOf, lineOf } from '../parsed.js';

export const parseVercelJson: FormatParser = (text) => {
  const config = JSON.parse(text) as { alias?: unknown };
  const aliases = Array.isArray(config.alias) ? config.alias : typeof config.alias === 'string' ? [config.alias] : [];
  const facts = aliases
    .filter((a): a is string => typeof a === 'string')
    .map((a) => ({ attribute: 'domain' as const, value: hostOf(a), line: lineOf(text, a) }));
  return { facts };
};

export const parseVercelProject: FormatParser = (text) => {
  const project = JSON.parse(text) as { projectId?: unknown; projectName?: unknown };
  const corpus: string[] = [];
  const projectNames: string[] = [];
  const identifiers: { vercelProjectId?: string } = {};
  if (typeof project.projectName === 'string') projectNames.push(project.projectName);
  if (typeof project.projectId === 'string') {
    identifiers.vercelProjectId = project.projectId;
    corpus.push(project.projectId);
  }
  return { projectNames, identifiers, corpus: [...corpus, ...projectNames] };
};
