// Export the current view. Nothing is ever written to disk unless the user
// clicks Export — and even then the file goes wherever their browser saves
// downloads. Toknado itself keeps no state between runs.

import { toDayKey } from './aggregate.js';

// Log-derived strings (project names, session ids, models) end up inside
// Markdown tables and CSV cells — neutralize the separators they could break.
const mdSafe = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const csvSafe = (s) => {
  const v = String(s ?? '');
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function toJSON(agg, comparison) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), ...agg, costComparison: comparison }, null, 2);
}

export function toCSV(agg) {
  const L = [];
  const row = (...cells) => L.push(cells.map(csvSafe).join(','));
  row('section', 'key', 'source', 'input', 'output', 'cache_read', 'cache_write', 'total', 'share_pct', 'events');
  for (const d of agg.days) {
    row('day', d.day, '', d.input, d.output, d.cacheRead, d.cacheWrite, d.total, d.sharePct, d.events);
  }
  for (const m of agg.models) {
    row('model', m.model, '', m.input, m.output, m.cacheRead, m.cacheWrite, m.total, m.sharePct, m.events);
  }
  for (const m of agg.modes) {
    row('mode', m.mode, m.source, m.input, m.output, m.cacheRead, m.cacheWrite, m.total, m.sharePct, m.events);
  }
  for (const s of agg.sessions) {
    row('session', `${s.project}/${s.sessionId}`, s.source, s.input, s.output, s.cacheRead, s.cacheWrite, s.total, s.sharePct, s.events);
  }
  for (const p of agg.projects) {
    row('project', p.project, p.source, p.input, p.output, p.cacheRead, p.cacheWrite, p.total, p.sharePct, p.events);
  }
  return L.join('\n') + '\n';
}

export function toMarkdown(agg, comparison) {
  const t = agg.totals;
  const fmt = (n) => n.toLocaleString('en-US');
  const L = [];
  L.push('# 🌪️ Toknado report');
  L.push('');
  L.push(`Generated: ${new Date().toISOString()}`);
  if (agg.range.since) {
    L.push(`Range: ${toDayKey(agg.range.since)} → ${toDayKey(agg.range.until)} (${agg.range.activeDays} active days)`);
  }
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Total tokens | ${fmt(t.total)} |`);
  L.push(`| Output | ${fmt(t.output)} |`);
  L.push(`| Fresh input | ${fmt(t.input)} |`);
  L.push(`| Cache read | ${fmt(t.cacheRead)} |`);
  L.push(`| Cache write | ${fmt(t.cacheWrite)} |`);
  L.push(`| Cache hit rate | ${t.cacheHitPct}% |`);
  L.push(`| Sessions | ${fmt(t.sessions)} |`);
  L.push(`| Avg / active day | ${fmt(t.avgPerActiveDay)} |`);
  L.push('');
  L.push('## By model');
  L.push('');
  L.push('| Model | Total | Share | Output |');
  L.push('|---|---:|---:|---:|');
  for (const m of agg.models) L.push(`| ${mdSafe(m.model)} | ${fmt(m.total)} | ${m.sharePct}% | ${fmt(m.output)} |`);
  L.push('');
  L.push('## By mode');
  L.push('');
  L.push('| Source | Mode | Total | Share |');
  L.push('|---|---|---:|---:|');
  for (const m of agg.modes) L.push(`| ${m.source} | ${mdSafe(m.mode)} | ${fmt(m.total)} | ${m.sharePct}% |`);
  L.push('');
  L.push('## Daily');
  L.push('');
  L.push('| Day | Total | Share | Output | Cache read |');
  L.push('|---|---:|---:|---:|---:|');
  for (const d of agg.days) L.push(`| ${d.day} | ${fmt(d.total)} | ${d.sharePct}% | ${fmt(d.output)} | ${fmt(d.cacheRead)} |`);
  L.push('');
  L.push('## Top sessions');
  L.push('');
  L.push('| Source | Project | Session | Total | Share |');
  L.push('|---|---|---|---:|---:|');
  for (const s of agg.sessions.slice(0, 20)) {
    L.push(`| ${s.source} | ${mdSafe(s.project)} | ${mdSafe(s.sessionId).slice(0, 8)}… | ${fmt(s.total)} | ${s.sharePct}% |`);
  }
  if (comparison) {
    L.push('');
    L.push('## What-if API cost comparison');
    L.push('');
    L.push(`> ${comparison.disclaimer}`);
    L.push('');
    L.push('| If the whole mix ran on… | Est. cost |');
    L.push('|---|---:|');
    for (const tier of comparison.tiers) {
      L.push(`| ${tier.label} | ${tier.cost == null ? '—' : '$' + fmt(tier.cost)} |`);
    }
  }
  L.push('');
  return L.join('\n');
}
