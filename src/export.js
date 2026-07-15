// Export the current view. Nothing is ever written to disk unless the user
// clicks Export — and even then the file goes wherever their browser saves
// downloads. Toknado itself keeps no state between runs.

export function toJSON(agg, comparison) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), ...agg, costComparison: comparison }, null, 2);
}

export function toCSV(agg) {
  const lines = ['day,input,output,cache_read,cache_write,total,share_pct,events'];
  for (const d of agg.days) {
    lines.push(
      [d.day, d.input, d.output, d.cacheRead, d.cacheWrite, d.total, d.sharePct, d.events].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function toMarkdown(agg, comparison) {
  const t = agg.totals;
  const fmt = (n) => n.toLocaleString('en-US');
  const L = [];
  L.push('# 🌪️ Toknado report');
  L.push('');
  L.push(`Generated: ${new Date().toISOString()}`);
  if (agg.range.since) {
    L.push(`Range: ${new Date(agg.range.since).toISOString().slice(0, 10)} → ${new Date(agg.range.until).toISOString().slice(0, 10)} (${agg.range.activeDays} active days)`);
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
  for (const m of agg.models) L.push(`| ${m.model} | ${fmt(m.total)} | ${m.sharePct}% | ${fmt(m.output)} |`);
  L.push('');
  L.push('## By mode');
  L.push('');
  L.push('| Source | Mode | Total | Share |');
  L.push('|---|---|---:|---:|');
  for (const m of agg.modes) L.push(`| ${m.source} | ${m.mode} | ${fmt(m.total)} | ${m.sharePct}% |`);
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
    L.push(`| ${s.source} | ${s.project} | ${s.sessionId.slice(0, 8)}… | ${fmt(s.total)} | ${s.sharePct}% |`);
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
