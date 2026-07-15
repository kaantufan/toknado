#!/usr/bin/env node
// 🌪️ Toknado — a tornado of tokens.
// Local, private token-usage dashboard for Claude Code & Codex CLI.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseClaudeLogs } from '../src/parse/claude.js';
import { parseCodexLogs } from '../src/parse/codex.js';
import { startServer } from '../src/server.js';

const HOME = os.homedir();

function parseArgs(argv) {
  const args = { port: 4141, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a === '--no-open') args.open = false;
    else if (a === '--claude-dir') args.claudeDir = argv[++i];
    else if (a === '--codex-dir') args.codexDir = argv[++i];
    else if (a === '--pricing') args.pricing = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `
  🌪️  toknado — a tornado of tokens

  Local, private usage dashboard for Claude Code & Codex CLI logs.
  Reads ~/.claude and ~/.codex, serves a dashboard on localhost.
  Nothing leaves your machine. Nothing is persisted.

  Usage:
    npx toknado [options]

  Options:
    -p, --port <n>        port to serve on (default 4141)
    --no-open             don't auto-open the browser
    --claude-dir <path>   Claude Code projects dir (default ~/.claude/projects)
    --codex-dir <path>    Codex home dir (default ~/.codex)
    --pricing <file>      JSON file with per-Mtok price overrides
    -h, --help            this message
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const claudeDir = args.claudeDir ?? path.join(HOME, '.claude', 'projects');
  const codexHome = args.codexDir ?? path.join(HOME, '.codex');
  const codexDirs = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];

  let userPrices = {};
  if (args.pricing) {
    try {
      userPrices = JSON.parse(fs.readFileSync(args.pricing, 'utf8'));
    } catch (err) {
      console.error(`⚠️  could not read pricing file: ${err.message}`);
    }
  }

  const loadData = async () => {
    const t0 = Date.now();
    const [claude, codex] = await Promise.all([
      parseClaudeLogs(claudeDir),
      parseCodexLogs(codexDirs),
    ]);
    const events = [...claude.events, ...codex.events];
    return {
      events,
      rateLimits: codex.rateLimits,
      meta: {
        claudeFiles: claude.filesScanned,
        codexFiles: codex.filesScanned,
        events: events.length,
        parseMs: Date.now() - t0,
      },
    };
  };

  console.log('🌪️  toknado is spinning up...');
  const first = await loadData();
  console.log(
    `   parsed ${first.meta.claudeFiles} Claude + ${first.meta.codexFiles} Codex files ` +
      `→ ${first.meta.events.toLocaleString()} usage events in ${first.meta.parseMs}ms`,
  );

  // Serve with a warm cache: first request reuses what we just parsed.
  let warm = first;
  const server = await startServer({
    port: args.port,
    userPrices,
    loadData: async () => {
      if (warm) {
        const w = warm;
        warm = null;
        return w;
      }
      return loadData();
    },
  });

  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`   dashboard: ${url}`);
  console.log('   (local only — nothing leaves your machine. Ctrl+C to stop)');

  if (args.open) openBrowser(url);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* non-fatal */
  }
}

main().catch((err) => {
  console.error('toknado failed:', err);
  process.exit(1);
});
