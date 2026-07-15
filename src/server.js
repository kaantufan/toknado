// Tiny zero-dependency HTTP server. Binds to 127.0.0.1 only — Toknado is
// local-first by design; nothing is ever sent anywhere.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, resolveRange, toDayKey } from './aggregate.js';
import { costComparison } from './pricing.js';
import { toJSON, toCSV, toMarkdown } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const RELOAD_INTERVAL_MS = 30_000;

export function startServer({ port, loadData, userPrices }) {
  let cache = null;
  let cacheAt = 0;
  let loading = null;

  async function data() {
    const now = Date.now();
    if (cache && now - cacheAt < RELOAD_INTERVAL_MS) return cache;
    if (!loading) {
      loading = loadData().then((d) => {
        cache = d;
        cacheAt = Date.now();
        loading = null;
        return d;
      }).catch((err) => {
        loading = null;
        // Cold start (requests are awaiting this promise): surface the error.
        // Background refresh with a stale cache: keep serving the stale data.
        if (!cache) throw err;
      });
    }
    return cache ?? loading;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url.pathname === '/api/data') {
        const d = await data();
        const filter = parseFilter(url);
        const agg = aggregate(d.events, d.rateLimits, filter);
        const comparison = costComparison(agg.models, agg.totals, userPrices);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...agg, costComparison: comparison, meta: d.meta }));
        return;
      }

      if (url.pathname === '/api/export') {
        const d = await data();
        const filter = parseFilter(url);
        const agg = aggregate(d.events, d.rateLimits, filter);
        const comparison = costComparison(agg.models, agg.totals, userPrices);
        const format = url.searchParams.get('format') ?? 'json';
        const stamp = toDayKey(Date.now());
        const send = (body, type, ext) => {
          res.writeHead(200, {
            'content-type': type,
            'content-disposition': `attachment; filename="toknado-${stamp}.${ext}"`,
          });
          res.end(body);
        };
        if (format === 'csv') send(toCSV(agg), 'text/csv; charset=utf-8', 'csv');
        else if (format === 'md') send(toMarkdown(agg, comparison), 'text/markdown; charset=utf-8', 'md');
        else send(toJSON(agg, comparison), 'application/json', 'json');
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`toknado error: ${err?.message ?? err}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function parseFilter(url) {
  const preset = url.searchParams.get('range');
  const source = url.searchParams.get('source') || undefined;
  let since = Number(url.searchParams.get('since')) || undefined;
  let until = Number(url.searchParams.get('until')) || undefined;
  if (preset && !since && !until) {
    [since, until] = resolveRange(preset);
  }
  return { since, until, source };
}
