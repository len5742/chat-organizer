import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_INSTALLATIONS = 64;

async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local activity refresh timed out.')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export function isLocalChat(item) {
  return item?.source === 'codex' && item.kind === 'chat'
    && (item.hostId == null || item.hostId === 'local')
    && typeof item.id === 'string' && typeof item.sourceId === 'string'
    && item.id === `codex:chat:${item.sourceId}` && item.sourceId.length > 0;
}

// Return only the fields this source can reliably refresh. Desktop project
// membership is owned elsewhere and can be absent from app-server metadata.
export function mapLocalActivity(item, thread) {
  if (!thread || thread.id !== item.sourceId) return null;
  const record = { id: item.id };
  if (typeof thread.name === 'string') {
    const title = thread.name.trim();
    if (title && title.length <= 1000) record.title = title;
  }
  if (typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt) && thread.updatedAt >= 0) {
    const date = new Date(thread.updatedAt * 1000);
    if (Number.isFinite(date.getTime())) record.updatedAt = date.toISOString();
  }
  return record;
}

export async function resolveCodexExecutable({ executablePath, localAppData = process.env.LOCALAPPDATA, override = process.env.CHAT_ORGANIZER_CODEX_EXECUTABLE } = {}) {
  const explicitPath = executablePath ?? override;
  if (explicitPath) {
    if (!isAbsolute(explicitPath) || !(await stat(explicitPath)).isFile()) throw new Error('Codex executable is unavailable.');
    return explicitPath;
  }
  if (!localAppData || !isAbsolute(localAppData)) throw new Error('Codex installation location is unavailable.');
  const installRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  const directories = (await readdir(installRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{8,64}$/i.test(entry.name));
  if (directories.length > MAX_INSTALLATIONS) throw new Error('Codex installation lookup exceeded its limit.');
  const candidates = await Promise.all(directories.map(async entry => {
    const path = join(installRoot, entry.name, 'codex.exe');
    try {
      const details = await stat(path);
      return details.isFile() ? { path, modified: details.mtimeMs } : null;
    } catch { return null; }
  }));
  const latest = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))[0];
  if (!latest) throw new Error('Codex executable is unavailable.');
  return latest.path;
}

function createMetadataRpc(executable, { spawnProcess, deadline }) {
  const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let failure = null;
  let exited = false;
  let outputBytes = 0;
  const fail = error => {
    failure = error instanceof Error ? error : new Error('Local activity service stopped.');
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => { exited = true; fail(new Error('Local activity service exited.')); });
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 8 * 1024 * 1024) fail(new Error('Local activity response exceeded its limit.'));
  });
  child.stderr.on('error', () => {});
  child.stderr.resume();
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error('Local chat metadata is unavailable.'));
    else request.resolve(message.result);
  });
  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error('Local activity refresh timed out.'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Local activity refresh timed out.'));
        }, Math.min(remaining, 6000));
        pending.set(id, { resolve, reject, timer });
        try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
        catch (error) { fail(error); }
      });
    },
    initialized() {
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    },
    dispose() {
      fail(new Error('Local activity refresh completed.'));
      lines.close();
      try { child.stdin.end(); } catch {}
      if (!exited) { try { child.kill(); } catch {} }
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

/** Read titles and update dates for saved local chats without loading turns. */
export async function readLocalActivity(items, {
  executablePath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = spawn,
  resolveExecutable = resolveCodexExecutable,
} = {}) {
  const eligible = [...new Map((Array.isArray(items) ? items : []).filter(isLocalChat).map(item => [item.id, item])).values()];
  const result = { records: [], attempted: eligible.length, checked: 0, unavailable: eligible.length };
  if (!eligible.length) return result;
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(60000, timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + duration;
  let rpc;
  try {
    const executable = await beforeDeadline(resolveExecutable({ executablePath }), deadline);
    if (Date.now() >= deadline) return result;
    rpc = createMetadataRpc(executable, { spawnProcess, deadline });
    await rpc.request('initialize', {
      clientInfo: { name: 'chat_organizer_activity_refresh', title: 'Chat Organizer activity refresh', version: '0.1.0' },
      capabilities: null,
    });
    rpc.initialized();
    let nextIndex = 0;
    const records = new Array(eligible.length);
    const worker = async () => {
      while (nextIndex < eligible.length && Date.now() < deadline) {
        const index = nextIndex++;
        const item = eligible[index];
        try {
          const response = await rpc.request('thread/read', { threadId: item.sourceId, includeTurns: false });
          records[index] = mapLocalActivity(item, response?.thread);
        } catch { /* Retain saved metadata for unavailable chats. */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, eligible.length) }, worker));
    result.records = records.filter(Boolean);
    result.checked = result.records.length;
  } catch { /* A missing or stopped local service leaves the saved catalog usable. */ }
  finally { rpc?.dispose(); }
  result.unavailable = result.attempted - result.checked;
  return result;
}
