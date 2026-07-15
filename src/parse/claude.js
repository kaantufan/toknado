// Parser for Claude Code JSONL session logs (~/.claude/projects/**/*.jsonl)
//
// Each session file contains one JSON object per line. Token usage lives on
// `assistant`-type entries under `message.usage`. Entries can be duplicated
// across files (session forks / continuations), so we dedupe on
// `message.id + requestId` — the same strategy ccusage uses.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Recursively collect *.jsonl files under a directory.
 * Follows symlinks (some setups relocate ~/.claude onto another disk) while
 * guarding against cycles and aliased directories via realpath.
 */
export function collectJsonlFiles(dir, seenDirs = new Set()) {
  const out = [];
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return out;
  }
  if (seenDirs.has(real)) return out; // cycle / aliased-dir guard
  seenDirs.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(p); // follows the link
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) out.push(...collectJsonlFiles(p, seenDirs));
    else if (isFile && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Parse all Claude Code logs into unified usage events.
 * @param {string} baseDir e.g. ~/.claude/projects
 * @returns {Promise<{events: Array, filesScanned: number}>}
 */
export async function parseClaudeLogs(baseDir) {
  const files = collectJsonlFiles(baseDir);
  const events = [];
  const seen = new Set();

  for (const file of files) {
    await parseFile(file, events, seen);
  }
  return { events, filesScanned: files.length };
}

async function parseFile(file, events, seen) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue; // fast pre-filter
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const msg = entry.message;
      const usage = msg?.usage;
      if (!usage) continue;

      const model = msg.model || 'unknown';
      if (model === '<synthetic>') continue; // internal placeholder entries

      // Dedupe: same API response can be recorded multiple times (streaming
      // re-logs within a file, forked/resumed sessions across files).
      const key = `${msg.id ?? ''}:${entry.requestId ?? ''}`;
      if (key !== ':') {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const ts = Date.parse(entry.timestamp ?? '') || 0;
      if (!ts) continue;

      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      if (input + output + cacheRead + cacheWrite === 0) continue;

      events.push({
        source: 'claude',
        ts,
        sessionId: entry.sessionId ?? path.basename(file, '.jsonl'),
        project: projectName(entry.cwd),
        model,
        // "mode" for Claude = response speed (fast mode vs standard)
        mode: usage.speed ? `speed:${usage.speed}` : null,
        input,
        output,
        cacheRead,
        cacheWrite,
      });
    }
  } catch {
    // File vanished mid-read (log rotation) or is unreadable — keep whatever
    // was parsed so far and move on.
  }
}

function projectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
