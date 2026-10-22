import { entityName } from '../compare/findings.js';
import { COST, DUPLICATED_MAX } from '../compare/score.js';
import type { AgentFormat, Finding, FindingType, Location, ScanResult } from '../types.js';
import { AGENT_LABELS, displayPath } from './terminal.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SECTIONS: { type: FindingType; title: string; lead: string }[] = [
  { type: 'conflict', title: 'Conflicts', lead: 'Files disagree about the same value, and a config file backs one of them.' },
  { type: 'global-local', title: 'Global vs repo', lead: 'Your machine-level agent config says something the repo does not.' },
  { type: 'stale', title: 'Stale references', lead: 'Named in a doc, but in no config file, ssh entry or cron job, and not on disk.' },
  { type: 'secret', title: 'Secrets in plain text', lead: 'Values are hidden here. Move each one to a secret store and rotate it.' },
  { type: 'duplicated', title: 'Duplicated in agent files', lead: 'The same fact in more than one agent file. Every copy is reloaded each session.' },
  { type: 'possible-conflict', title: 'Worth a look', lead: 'Values disagree, but no config file settles it (or a box may have more than one IP). Not counted in the score.' },
];

function locations(at: Location[], root: string): string {
  return at.map((a) => `<code>${esc(`${displayPath(a.path, root)}:${a.line}`)}</code>`).join(' ');
}

function heading(f: Finding): string {
  const subject = f.entityId ? `${entityName(f.entityId)} ${f.attribute ?? ''}` : (f.attribute ?? '');
  switch (f.type) {
    case 'secret': return `Possible secret <code>${esc(f.masked ?? '')}</code>`;
    case 'stale': return `${esc(subject)} <code>${esc(f.values?.[0]?.value ?? '')}</code>`;
    case 'duplicated': return `${esc(subject)} <code>${esc(f.values?.[0]?.value ?? '')}</code> · ~${f.tokens ?? 0} tokens`;
    default: return esc(subject);
  }
}

function item(f: Finding, root: string): string {
  const rows = f.type === 'secret' || f.type === 'stale' || f.type === 'duplicated'
    ? `<p class="at">${locations(f.at ?? [], root)}</p>`
    : `<ul>${(f.values ?? []).map((g) => `<li><span class="val">${esc(g.value)}</span>${g.truthBacked ? '<span class="tag">config</span>' : ''} ${locations(g.at, root)}</li>`).join('')}</ul>`;
  return `<li class="finding"><h3>${heading(f)}</h3><p class="msg">${esc(f.message)}</p>${rows}</li>`;
}

export function renderHtml(r: ScanResult): string {
  const count = (t: FindingType) => r.findings.filter((f) => f.type === t).length;
  const pct = Math.round((100 * r.duplicatedTokens) / Math.max(r.agentTokens, 1));
  const agentFiles = (Object.entries(r.agentFileCounts) as [AgentFormat, number][]).filter(([, n]) => n > 0);
  const sections = SECTIONS.map((s) => {
    const found = r.findings.filter((f) => f.type === s.type);
    if (found.length === 0) return '';
    return `<section><h2>${s.title} <span class="n">${found.length}</span></h2><p class="lead">${s.lead}</p><ul class="list">${found.map((f) => item(f, r.root)).join('')}</ul></section>`;
  }).join('');
  const skipped = r.skipped.length === 0 ? '' :
    `<p>Skipped, so not checked:</p><ul>${r.skipped.map((s) => `<li><code>${esc(displayPath(s.path, r.root))}</code> ${esc(s.reason)}${s.note ? `: ${esc(s.note)}` : ''}</li>`).join('')}</ul>`;
  const read = r.machineFilesRead.length === 0 ? '<p>No machine-level files were read.</p>' :
    `<p>Machine-level files read:</p><ul>${r.machineFilesRead.map((p) => `<li><code>${esc(p === 'crontab -l' ? p : displayPath(p, r.root))}</code></li>`).join('')}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sync-agent-docs report</title>
<style>
:root { --bg: #ffffff; --fg: #1a1d21; --muted: #5c6370; --line: #e3e6ea; --soft: #f5f6f8; --accent: #b42318; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 4px; }
h3 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
.sub, .lead, .msg { color: var(--muted); margin: 0 0 12px; }
.score { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 16px; background: var(--soft); border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; }
.score b { font-size: 28px; display: block; }
.n { color: var(--muted); font-weight: 400; }
.list { list-style: none; padding: 0; margin: 0; }
.finding { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; }
.finding ul { margin: 0; padding-left: 18px; }
.finding li { margin: 4px 0; }
.val { font-weight: 600; }
.tag { font-size: 12px; border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 6px; color: var(--muted); }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.at { margin: 0; }
section:first-of-type h2 { color: var(--accent); }
footer { margin-top: 40px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>Context health ${r.score}/100</h1>
<p class="sub">Scanned <code>${esc(displayPath(r.root, '\0'))}</code> at ${esc(r.scannedAt)}. Read-only; nothing left this machine.</p>
<div class="score">
<div><b>${count('conflict')}</b>conflicts</div>
<div><b>${count('global-local')}</b>global vs repo</div>
<div><b>${count('stale')}</b>stale</div>
<div><b>${count('secret')}</b>secrets</div>
<div><b>${pct}%</b>duplicated</div>
</div>
<p class="sub">${r.repos.length} repos, ${agentFiles.reduce((a, [, n]) => a + n, 0)} agent instruction files${agentFiles.length ? ` (${agentFiles.map(([a, n]) => `${esc(AGENT_LABELS[a])} ×${n}`).join(', ')})` : ''}, ${r.facts.length} infra facts.</p>
${sections || '<p>No conflicts, stale references or plain-text secrets found.</p>'}
<section>
<h2>What scan cannot see</h2>
<p class="lead">Prose without a value ("the usual port"), what is actually running right now, facts that live only in a dashboard or someone's head, and any file listed below as skipped. A high score means your files agree with each other, not that they match reality.</p>
${read}
${skipped}
</section>
<footer>sync-agent-docs scan · score = 100 minus ${COST.conflict} per conflict or global-vs-repo, ${COST.stale} per stale reference, ${COST.secret} per secret, and up to ${DUPLICATED_MAX} for duplicated agent-file tokens.</footer>
</main>
</body>
</html>
`;
}
