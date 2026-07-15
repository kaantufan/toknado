// Parser for Codex CLI rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
//
// Codex logs are event streams. Usage arrives as `event_msg` entries with
// payload.type === "token_count", carrying the cumulative `total_token_usage`
// and the last API call's own usage (`last_token_usage`).
//
// THE TRAP: when Codex forks a thread (subagents, resumes), the new rollout
// file COPIES the parent's entire event history — with rewritten timestamps —
// then appends its own events. In fork-heavy multiagent workflows >90% of all
// token_count lines can be copies. Summing per file (or per event) massively
// overcounts; several popular tools get this wrong.
//
// Strategy: deduplicate globally on the (total_token_usage, last_token_usage)
// snapshot — the cumulative counter makes each logical API call's snapshot
// unique within a lineage, and copies are byte-identical. Files are walked in
// lexicographic (= chronological) order so the original occurrence, with the
// true timestamp, wins. Each unique call then contributes exactly its own
// `last_token_usage` once.
//
// Model + reasoning effort come from `turn_context` events; events that occur
// before the first turn_context are backfilled with the file's first-seen
// model.

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
  // Lexicographic order == chronological order for rollout-<ISO date> names,
  // so the original copy of a duplicated event is always seen first.
  const files = baseDirs.flatMap((d) => collectJsonlFiles(d)).sort();
  const events = [];
  const rateLimits = [];
  const seenCalls = new Set();
  const seenQuota = new Set();

  for (const file of files) {
    await parseFile(file, events, rateLimits, seenCalls, seenQuota);
  }
  rateLimits.sort((a, b) => a.ts - b.ts);
  return { events, rateLimits, filesScanned: files.length };
}

async function parseFile(file, events, rateLimits, seenCalls, seenQuota) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = path.basename(file, '.jsonl');
  let project = 'unknown';
  let agent = null; // subagent nickname, if any
  let model = null;
  let effort = null;
  const pendingModel = []; // events created before the first turn_context

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
      sessionId = payload.id ?? sessionId;
      project = projectName(payload.cwd);
      agent = payload.agent_nickname ?? null;
      if (payload.model) model = payload.model; // some log versions carry it here
      continue;
    }

    if (entry.type === 'turn_context') {
      if (payload.model) {
        model = payload.model;
        // Backfill events that arrived before we knew the model.
        while (pendingModel.length) pendingModel.pop().model = model;
      }
      const eff = payload.collaboration_mode?.settings?.reasoning_effort ?? payload.effort;
      if (eff) effort = eff;
      if (payload.cwd) project = projectName(payload.cwd);
      continue;
    }

    if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;

    const ts = Date.parse(entry.timestamp ?? '') || 0;
    const info = payload.info;

    if (info?.last_token_usage && ts) {
      // Global fork-copy dedup: the cumulative+last snapshot identifies one
      // logical API call across every file that copied it.
      const key = crypto
        .createHash('md5')
        .update(JSON.stringify(info.total_token_usage) + '|' + JSON.stringify(info.last_token_usage))
        .digest('base64');

      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        const l = info.last_token_usage;
        const cached = l.cached_input_tokens ?? 0;
        // Codex `input_tokens` INCLUDES cached tokens; normalize to the
        // Claude convention where `input` is fresh (uncached) input.
        const freshInput = Math.max(0, (l.input_tokens ?? 0) - cached);
        const output = l.output_tokens ?? 0;
        if (freshInput + cached + output > 0) {
          const ev = {
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
          };
          events.push(ev);
          if (model == null) pendingModel.push(ev);
        }
      }
    }

    // Real quota data — Codex reports rate-limit window usage inline.
    const rlInfo = payload.rate_limits?.primary;
    if (rlInfo && ts && typeof rlInfo.used_percent === 'number') {
      // Dedup fork copies by snapshot content; bucket to one sample/minute.
      const minute = Math.floor(ts / 60000);
      const qKey = `${minute}|${rlInfo.used_percent}|${rlInfo.resets_at ?? ''}`;
      if (!seenQuota.has(qKey)) {
        seenQuota.add(qKey);
        rateLimits.push({
          ts,
          usedPercent: rlInfo.used_percent,
          windowMinutes: rlInfo.window_minutes ?? null,
          plan: payload.rate_limits.plan_type ?? null,
        });
      }
    }
  }
}

function projectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
