// Parser for Codex CLI rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
//
// Codex logs are event streams. Usage arrives as `event_msg` entries with
// payload.type === "token_count", carrying the cumulative `total_token_usage`
// and the last API call's own usage (`last_token_usage`).
//
// THE TRAP: when Codex forks a thread (subagents, resumes), the new rollout
// file COPIES the parent's entire event history — with rewritten timestamps
// and the parent's session_meta lines interleaved — then appends its own
// events. In fork-heavy multiagent workflows >90% of all token_count lines
// can be copies. Summing per file (or per event) massively overcounts;
// several popular tools get this wrong.
//
// Strategy:
//  * Deduplicate globally on the (total_token_usage, last_token_usage)
//    snapshot — the cumulative counter makes each logical API call's snapshot
//    unique within a lineage, and copies are byte-identical.
//  * Walk files in chronological order (by rollout filename, which embeds the
//    creation timestamp) so the original occurrence, with the true timestamp,
//    wins over fork copies.
//  * Honor only the FIRST session_meta per file: it is always the file's own
//    (its id matches the filename UUID); later ones are fork-copied parent
//    history and would misattribute the thread's usage to its parent.
//  * Record quota (rate-limit) samples only alongside a first-seen usage
//    snapshot, keyed per limit_id — fork copies rewrite timestamps, so
//    time-based dedup alone cannot catch them.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { collectJsonlFiles } from './claude.js';

/**
 * Parse all Codex logs into unified usage events.
 * @param {string[]} baseDirs e.g. [~/.codex/sessions, ~/.codex/archived_sessions]
 * @returns {Promise<{events: Array, rateLimits: Array, filesScanned: number}>}
 */
export async function parseCodexLogs(baseDirs) {
  // Sort by basename (rollout-<timestamp>-<uuid>.jsonl): chronological order
  // must hold ACROSS baseDirs — archived_sessions/ would otherwise jump ahead
  // of sessions/ just because its full path sorts first.
  const files = baseDirs
    .flatMap((d) => collectJsonlFiles(d))
    .sort((a, b) => {
      const na = path.basename(a);
      const nb = path.basename(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  const events = [];
  const rateLimits = [];
  const seenCalls = new Set();

  for (const file of files) {
    await parseFile(file, events, rateLimits, seenCalls);
  }
  rateLimits.sort((a, b) => a.ts - b.ts);
  return { events, rateLimits, filesScanned: files.length };
}

async function parseFile(file, events, rateLimits, seenCalls) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = path.basename(file, '.jsonl');
  let project = 'unknown';
  let agent = null; // subagent nickname, if any
  let model = null;
  let effort = null;
  let sawMeta = false;

  try {
    for await (const line of rl) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry.payload;
      if (!payload) continue;

      if (entry.type === 'session_meta') {
        // Only the first session_meta describes THIS file; later ones are
        // fork-copied parent history (parent id, no nickname).
        if (!sawMeta) {
          sawMeta = true;
          sessionId = payload.id ?? sessionId;
          project = projectName(payload.cwd);
          agent = payload.agent_nickname ?? null;
          if (payload.model) model = payload.model;
        }
        continue;
      }

      if (entry.type === 'turn_context') {
        if (payload.model) model = payload.model;
        const eff = payload.collaboration_mode?.settings?.reasoning_effort ?? payload.effort;
        if (eff) effort = eff;
        if (payload.cwd) project = projectName(payload.cwd);
        continue;
      }

      if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;

      const ts = Date.parse(entry.timestamp ?? '') || 0;
      const info = payload.info;
      if (!info?.last_token_usage || !ts) continue;

      // Global fork-copy dedup: the cumulative+last snapshot identifies one
      // logical API call across every file that copied it.
      const key = crypto
        .createHash('md5')
        .update(JSON.stringify(info.total_token_usage) + '|' + JSON.stringify(info.last_token_usage))
        .digest('base64');
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);

      const l = info.last_token_usage;
      const cached = l.cached_input_tokens ?? 0;
      // Codex `input_tokens` INCLUDES cached tokens; normalize to the Claude
      // convention where `input` is fresh (uncached) input.
      const freshInput = Math.max(0, (l.input_tokens ?? 0) - cached);
      const output = l.output_tokens ?? 0;
      if (freshInput + cached + output > 0) {
        events.push({
          source: 'codex',
          ts,
          sessionId,
          project,
          agent,
          model: model ?? 'unknown',
          mode: effort ? `effort:${effort}` : null,
          input: freshInput,
          output,
          cacheRead: cached,
          cacheWrite: 0, // Codex does not report cache writes separately
          reasoningOutput: l.reasoning_output_tokens ?? 0,
        });
      }

      // Real quota data — recorded only for first-seen calls, so fork copies
      // (which rewrite timestamps) can never pollute the timeline.
      const rlInfo = payload.rate_limits?.primary;
      if (rlInfo && typeof rlInfo.used_percent === 'number') {
        rateLimits.push({
          ts,
          usedPercent: rlInfo.used_percent,
          windowMinutes: rlInfo.window_minutes ?? null,
          plan: payload.rate_limits.plan_type ?? null,
          limitId: payload.rate_limits.limit_id ?? 'default',
        });
      }
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
