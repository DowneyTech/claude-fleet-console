import { randomUUID } from 'node:crypto';
import { execLines } from './docker.js';
import { pollContainer } from './remoteUsage.js';
import { clearCurrent, resolveSession } from './sessionStore.js';
import { recordResult } from './usageStore.js';

// コンテナ名 → 現在（または直近）のタスク。ページを再読み込みしても
// 実行中タスクに再アタッチできるよう、イベントをここに貯めておく。
const tasks = new Map();

const MAX_EVENTS = 3000;

export function getTask(name) {
  return tasks.get(name) ?? null;
}

export function isBusy(name) {
  const task = tasks.get(name);
  return Boolean(task) && !task.done;
}

function emit(task, kind, data) {
  const event = { seq: task.nextSeq++, at: Date.now(), kind, data };
  task.events.push(event);
  if (task.events.length > MAX_EVENTS) {
    task.events.shift();
    task.dropped += 1;
  }

  const payload = `event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of task.subscribers) {
    res.write(payload);
  }
  return event;
}

export function subscribe(task, res) {
  // 上限を超えて捨てた分があることを黙って隠さない。
  if (task.dropped > 0) {
    const notice = {
      seq: -1,
      at: Date.now(),
      kind: 'raw',
      data: { line: `（古いイベント ${task.dropped} 件は表示上限を超えたため省略されています）` },
    };
    res.write(`event: raw\ndata: ${JSON.stringify(notice)}\n\n`);
  }

  // 途中参加でも文脈が分かるよう、これまでのイベントを再生してから購読に入る。
  for (const event of task.events) {
    res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  if (task.done) {
    res.write(`event: closed\ndata: ${JSON.stringify({ exitCode: task.exitCode })}\n\n`);
    res.end();
    return;
  }

  task.subscribers.add(res);
  res.on('close', () => task.subscribers.delete(res));
}

function finish(task, { exitCode, error }) {
  task.done = true;
  task.endedAt = Date.now();
  task.exitCode = exitCode ?? null;
  task.error = error ?? null;

  emit(task, 'end', { exitCode: task.exitCode, error: task.error, durationMs: task.endedAt - task.startedAt });

  for (const res of task.subscribers) {
    res.write(`event: closed\ndata: ${JSON.stringify({ exitCode: task.exitCode })}\n\n`);
    res.end();
  }
  task.subscribers.clear();
}

/**
 * コンテナ内で `claude -p` を起動し、stream-json の各行をイベントとして貯める。
 * 同じコンテナで実行中のタスクがある場合は例外（呼び出し側が 409 にする）。
 */
export async function startTask(cfg, { prompt, newSession = false }) {
  if (isBusy(cfg.name)) {
    const err = new Error('このコンテナでは既にタスクが実行中です');
    err.status = 409;
    throw err;
  }

  const task = {
    id: randomUUID(),
    container: cfg.name,
    prompt,
    sessionId: null,
    sessionMode: null,
    startedAt: Date.now(),
    endedAt: null,
    done: false,
    exitCode: null,
    error: null,
    usage: null,
    events: [],
    nextSeq: 0,
    dropped: 0,
    subscribers: new Set(),
  };
  // await を挟む前に枠を確保する。セッション解決を待ってから登録すると、
  // 同時に来たリクエストが両方とも isBusy を通過して二重起動する。
  tasks.set(cfg.name, task);

  let session;
  try {
    session = await resolveSession(cfg.name, cfg.workspacePath, { newSession });
  } catch (err) {
    // 枠を握ったまま失敗すると、そのコンテナが永久に busy になる。
    finish(task, { exitCode: null, error: err.message });
    throw err;
  }

  task.sessionId = session.id;
  task.sessionMode = session.mode;

  const cmd = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (cfg.permissionMode) cmd.push('--permission-mode', cfg.permissionMode);
  if (Array.isArray(cfg.allowedTools) && cfg.allowedTools.length > 0) {
    cmd.push('--allowedTools', cfg.allowedTools.join(','));
  }
  // 新規セッションは ID を先に固定でき、以降は同じ ID を resume できる。
  cmd.push(session.mode === 'new' ? '--session-id' : '--resume', session.id);

  emit(task, 'start', {
    prompt,
    sessionId: session.id,
    sessionMode: session.mode,
    permissionMode: cfg.permissionMode ?? null,
  });

  // 応答は待たずに走らせ、購読側へ逐次流す。
  execLines(cfg.name, cmd, {
    workingDir: cfg.workspacePath,
    onStdoutLine: (line) => {
      // パース失敗と集計時のエラーを取り違えないよう、try を分ける。
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        emit(task, 'raw', { line });
        return;
      }

      // 使用量は result イベントにだけ載る。ストリームへ流す前に確定させ、
      // SSE 受信直後にポーリングした UI が古い累計を見ないようにする。
      const usage = obj.type === 'result' ? recordResult(cfg.name, obj) : null;
      if (usage) task.usage = usage;

      emit(task, 'stream', obj);
    },
    onStderr: (chunk) => emit(task, 'stderr', { text: chunk }),
  })
    .then((exitCode) => {
      // 新規セッションが立ち上がらないまま失敗した場合、その UUID で resume はできない。
      if (exitCode !== 0 && session.mode === 'new') clearCurrent(cfg.name);
      finish(task, { exitCode });
    })
    .catch((err) => {
      if (session.mode === 'new') clearCurrent(cfg.name);
      finish(task, { exitCode: null, error: err.message });
    })
    .finally(() => {
      // タスク実行はレート上限が変わる主な契機。30秒ポーリングを待たず
      // ここで前倒しして取得する（失敗しても pollContainer 内で握りつぶす）。
      pollContainer(cfg.name);
    });

  return task;
}

/** API レスポンス用の軽量スナップショット（events は含めない）。 */
export function snapshot(task) {
  if (!task) return null;
  return {
    id: task.id,
    container: task.container,
    prompt: task.prompt,
    sessionId: task.sessionId,
    sessionMode: task.sessionMode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    done: task.done,
    exitCode: task.exitCode,
    error: task.error,
    usage: task.usage,
    eventCount: task.events.length,
  };
}
