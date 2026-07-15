// Parser for GitHub Copilot Chat (VS Code) session logs.
//
// VS Code stores one file per chat session under
//   <VS Code user dir>/workspaceStorage/<hash>/chatSessions/*.jsonl  (op log)
//   <VS Code user dir>/workspaceStorage/<hash>/chatSessions/*.json   (legacy snapshot)
//
// The .jsonl format is an operation log: each line is {kind, k, v}.
//   kind 0                      → initial session snapshot (sessionId, may carry requests)
//   kind 2, k=["requests"]      → append one request object (requestId, timestamp, modelId)
//   kind 1, k=["requests",i,"result"] → set request i's result; usage lives at v.usage
//     v.usage = { promptTokens, completionTokens } — no cache split is recorded.
//
// The same sessionId can exist as both .json and .jsonl (format migration
// copies) — .jsonl wins. Requests are deduped globally by requestId.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default VS Code user-data locations per platform (incl. Insiders). */
export function defaultCopilotDirs() {
  const home = os.homedir();
  const roots =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support')]
      : process.platform === 'win32'
        ? [process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')]
        : [process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')];
  const flavors = ['Code', 'Code - Insiders', 'VSCodium'];
  const dirs = [];
  for (const root of roots) {
    for (const flavor of flavors) {
      dirs.push(path.join(root, flavor, 'User', 'workspaceStorage'));
    }
  }
  return dirs;
}

/**
 * Parse Copilot Chat sessions into unified usage events.
 * @param {string[]} workspaceStorageDirs
 * @returns {Promise<{events: Array, filesScanned: number}>}
 */
export async function parseCopilotLogs(workspaceStorageDirs) {
  const events = [];
  const seenRequests = new Set();
  let filesScanned = 0;

  for (const storageDir of workspaceStorageDirs) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(storageDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(storageDir, ws.name);
      const sessionsDir = path.join(wsDir, 'chatSessions');
      let files;
      try {
        files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      const project = workspaceProject(wsDir);

      // .jsonl wins over a legacy .json snapshot of the same session
      const jsonlStems = new Set(files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)));
      for (const f of files) {
        if (f.endsWith('.json') && jsonlStems.has(f.slice(0, -5))) continue;
        const file = path.join(sessionsDir, f);
        filesScanned++;
        try {
          const requests = f.endsWith('.jsonl') ? replayOpLog(file) : snapshotRequests(file);
          const sessionId = f.replace(/\.jsonl?$/, '');
          for (const r of requests) {
            emit(r, sessionId, project, events, seenRequests);
          }
        } catch {
          /* unreadable / malformed session file — skip */
        }
      }
    }
  }
  return { events, filesScanned };
}

/** Replay a .jsonl op log into a requests array with results attached. */
function replayOpLog(file) {
  const requests = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      continue;
    }
    const k = op.k;
    if (op.kind === 0 && Array.isArray(op.v?.requests)) {
      // initial snapshot may already carry requests
      requests.push(...op.v.requests);
    } else if (op.kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests') {
      // append op — v is a single request OR an array of requests
      if (Array.isArray(op.v)) requests.push(...op.v);
      else requests.push(op.v ?? {});
    } else if (
      op.kind === 1 &&
      Array.isArray(k) &&
      k.length === 3 &&
      k[0] === 'requests' &&
      k[2] === 'result'
    ) {
      const i = k[1];
      if (requests[i]) requests[i].result = op.v; // last write wins
    }
  }
  return requests;
}

/** Legacy single-JSON snapshot: {requests: [...]}. */
function snapshotRequests(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(doc?.requests) ? doc.requests : [];
}

function emit(request, sessionId, project, events, seenRequests) {
  const usage = request?.result?.usage;
  if (!usage) return;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  if (input + output === 0) return;

  const id = request.requestId ?? `${sessionId}:${request.timestamp ?? ''}`;
  if (seenRequests.has(id)) return;
  seenRequests.add(id);

  const ts = typeof request.timestamp === 'number' ? request.timestamp : 0;
  if (!ts) return;

  // modelId comes as "copilot/gpt-5.2" — keep the bare model name; the
  // provider is already carried by source: 'copilot'.
  const rawModel = request.modelId ?? 'unknown';
  const model = rawModel.includes('/') ? rawModel.slice(rawModel.lastIndexOf('/') + 1) : rawModel;

  events.push({
    source: 'copilot',
    ts,
    sessionId,
    project,
    model,
    mode: null,
    input, // promptTokens is the full prompt; Copilot records no cache split
    output,
    cacheRead: 0,
    cacheWrite: 0,
  });
}

/** Resolve the workspace folder name from workspaceStorage/<hash>/workspace.json. */
function workspaceProject(wsDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder ?? meta.workspace ?? '';
    const decoded = decodeURIComponent(String(uri));
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}
