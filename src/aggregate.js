// Aggregation: turn the flat event list into everything the dashboard needs.
// All computation happens in memory on every request — Toknado never persists
// anything; the CLI logs themselves are the only source of truth.

const DAY_MS = 86_400_000;

export function toDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, events: 0 };
}

function add(bucket, ev) {
  bucket.input += ev.input;
  bucket.output += ev.output;
  bucket.cacheRead += ev.cacheRead;
  bucket.cacheWrite += ev.cacheWrite;
  bucket.total += ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
  bucket.events += 1;
}

/**
 * @param {Array} events unified events from both parsers
 * @param {Array} rateLimits codex quota samples
 * @param {{since?: number, until?: number, source?: string}} filter
 */
export function aggregate(events, rateLimits, filter = {}) {
  const { since = 0, until = Infinity, source } = filter;

  const totals = emptyBucket();
  const bySource = new Map();
  const byDay = new Map();
  const byModel = new Map();
  const byMode = new Map();
  const bySession = new Map();
  const byProject = new Map();
  const byHour = Array.from({ length: 24 }, () => emptyBucket());
  const byDayBySource = new Map(); // day -> {claude: n, codex: n}
  const byDayByType = new Map(); // day -> bucket

  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const ev of events) {
    if (ev.ts < since || ev.ts > until) continue;
    if (source && ev.source !== source) continue;

    if (ev.ts < minTs) minTs = ev.ts;
    if (ev.ts > maxTs) maxTs = ev.ts;

    add(totals, ev);

    upsert(bySource, ev.source, ev);
    const day = toDayKey(ev.ts);
    upsert(byDay, day, ev);
    upsert(byModel, ev.model, ev);
    if (ev.mode) upsert(byMode, `${ev.source}|${ev.mode}`, ev);
    upsert(bySession, `${ev.source}|${ev.sessionId}`, ev, (b) => {
      b.project = ev.project;
      b.source = ev.source;
      b.firstTs = Math.min(b.firstTs ?? Infinity, ev.ts);
      b.lastTs = Math.max(b.lastTs ?? 0, ev.ts);
      if (ev.model) (b.models ??= new Set()).add(ev.model);
    });
    upsert(byProject, `${ev.source}|${ev.project}`, ev, (b) => {
      b.source = ev.source;
    });
    add(byHour[new Date(ev.ts).getHours()], ev);

    // day x source (for the stacked-by-source view)
    let ds = byDayBySource.get(day);
    if (!ds) byDayBySource.set(day, (ds = {}));
    ds[ev.source] = (ds[ev.source] ?? 0) + ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
  }

  const grand = totals.total || 1;

  // ---- shape the output ----
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, b]) => ({
      day,
      ...plain(b),
      sharePct: pct(b.total, grand),
      sources: byDayBySource.get(day) ?? {},
    }));

  const models = [...byModel.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([model, b]) => ({ model, ...plain(b), sharePct: pct(b.total, grand) }));

  const modes = [...byMode.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([key, b]) => {
      const [src, mode] = key.split('|');
      return { source: src, mode, ...plain(b), sharePct: pct(b.total, grand) };
    });

  const sessions = [...bySession.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 50)
    .map(([key, b]) => ({
      source: b.source,
      sessionId: key.split('|')[1],
      project: b.project,
      models: b.models ? [...b.models] : [],
      firstTs: b.firstTs,
      lastTs: b.lastTs,
      ...plain(b),
      sharePct: pct(b.total, grand),
    }));

  const projects = [...byProject.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 30)
    .map(([key, b]) => ({
      source: b.source,
      project: key.split('|')[1],
      ...plain(b),
      sharePct: pct(b.total, grand),
    }));

  const sources = [...bySource.entries()].map(([src, b]) => ({
    source: src,
    ...plain(b),
    sharePct: pct(b.total, grand),
  }));

  // Codex quota timeline, filtered to range, downsampled to ≤ 500 points
  const quota = downsample(
    rateLimits.filter((r) => r.ts >= since && r.ts <= until),
    500,
  );

  const activeDays = days.filter((d) => d.total > 0).length;

  return {
    range: {
      since: Number.isFinite(minTs) ? minTs : null,
      until: Number.isFinite(maxTs) ? maxTs : null,
      activeDays,
    },
    totals: {
      ...plain(totals),
      cacheHitPct: pct(totals.cacheRead, totals.cacheRead + totals.input + totals.cacheWrite || 1),
      avgPerActiveDay: activeDays ? Math.round(totals.total / activeDays) : 0,
      sessions: bySession.size,
    },
    sources,
    days,
    models,
    modes,
    sessions,
    projects,
    hours: byHour.map((b, h) => ({ hour: h, ...plain(b) })),
    quota,
  };
}

function upsert(map, key, ev, extend) {
  let b = map.get(key);
  if (!b) map.set(key, (b = emptyBucket()));
  add(b, ev);
  if (extend) extend(b);
  return b;
}

function plain(b) {
  return {
    input: b.input,
    output: b.output,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
    total: b.total,
    events: b.events,
  };
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10000) / 100;
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

/** Resolve preset range names to [since, until] epoch ms. */
export function resolveRange(preset, now = Date.now()) {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = (n) => startOfToday.getTime() - (n - 1) * DAY_MS;

  switch (preset) {
    case 'today':
      return [startOfToday.getTime(), endOfToday.getTime()];
    case '7d':
      return [day(7), endOfToday.getTime()];
    case '14d':
      return [day(14), endOfToday.getTime()];
    case '30d':
      return [day(30), endOfToday.getTime()];
    case 'all':
    default:
      return [0, endOfToday.getTime()];
  }
}
