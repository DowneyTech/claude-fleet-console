import { execCapture } from './docker.js';
import { SESSION_ID_RE, sessionDir } from './sessionStore.js';

const MAX_TEXT = 4000;
const MAX_TOOL_INPUT = 600;

// 長時間のセッションは 10MB を超えることがある。丸ごと読むとメモリと
// レスポンスサイズが跳ねるので、大きいものは末尾だけを返す。
const MAX_SESSION_BYTES = 4 * 1024 * 1024;

function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text == null) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** transcript の 1 エントリを、UI が描画しやすいブロック列へ落とす。 */
function toMessage(entry) {
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;

  if (entry.type === 'summary') {
    return { role: 'summary', ts, blocks: [{ kind: 'text', text: entry.summary ?? '' }] };
  }

  const message = entry.message;
  if (!message) return null;

  const role = message.role ?? entry.type;
  const content = message.content;
  const blocks = [];

  if (typeof content === 'string') {
    blocks.push({ kind: 'text', text: clip(content, MAX_TEXT) });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text') {
        blocks.push({ kind: 'text', text: clip(part.text ?? '', MAX_TEXT) });
      } else if (part?.type === 'thinking') {
        blocks.push({ kind: 'thinking', text: clip(part.thinking ?? '', MAX_TEXT) });
      } else if (part?.type === 'tool_use') {
        blocks.push({
          kind: 'tool_use',
          name: part.name ?? 'tool',
          input: clip(part.input, MAX_TOOL_INPUT),
        });
      } else if (part?.type === 'tool_result') {
        blocks.push({
          kind: 'tool_result',
          ok: !part.is_error,
          text: clip(part.content, MAX_TOOL_INPUT),
        });
      }
    }
  }

  if (blocks.length === 0) return null;
  return { role, ts, blocks };
}

/** セッション jsonl を cat して、チャット風のメッセージ配列に整形する。 */
export async function readSession(name, workspacePath, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    const err = new Error('invalid session id');
    err.status = 400;
    throw err;
  }

  const file = `${sessionDir(workspacePath)}/${sessionId}.jsonl`;

  const { stdout: sizeOut } = await execCapture(name, ['stat', '-c', '%s', file]);
  const bytes = Number(sizeOut.trim());
  const truncated = Number.isFinite(bytes) && bytes > MAX_SESSION_BYTES;

  // シェルを挟まないので、パスのクォート事故もインジェクションも起きない。
  const { stdout, exitCode, stderr } = await execCapture(
    name,
    truncated ? ['tail', '-c', String(MAX_SESSION_BYTES), file] : ['cat', file],
  );

  if (exitCode !== 0) {
    const err = new Error(stderr.trim() || 'session not found');
    err.status = 404;
    throw err;
  }

  const messages = [];
  let malformed = 0;

  const lines = stdout.split('\n');
  // 末尾を切り出した場合、先頭行は途中で切れているので捨てる。
  if (truncated) lines.shift();

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const message = toMessage(entry);
    if (message) messages.push(message);
  }

  return {
    sessionId,
    messages,
    malformed,
    truncated,
    bytes: Number.isFinite(bytes) ? bytes : null,
    firstAt: messages.find((m) => m.ts)?.ts ?? null,
    lastAt: [...messages].reverse().find((m) => m.ts)?.ts ?? null,
  };
}
