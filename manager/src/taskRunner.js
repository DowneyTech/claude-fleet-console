import { randomUUID } from 'node:crypto';
import { getContainerConfig } from './config.js';
import { execCapture, execLines } from './docker.js';
import { pollContainer } from './remoteUsage.js';
import { clearCurrent, resolveSession } from './sessionStore.js';
import { recordResult, recordTicketUsage } from './usageStore.js';

// コンテナ名 → 現在（または直近）のタスク。ページを再読み込みしても
// 実行中タスクに再アタッチできるよう、イベントをここに貯めておく。
const tasks = new Map();

// コンテナ名 → 実行待ちのタスク配列。busy なコンテナへの投入はここに積み、
// 現在のタスクが終わるたびに先頭から自動で起動する（すべてメモリ上のみ）。
const queues = new Map();

const MAX_EVENTS = 3000;

export function getTask(name) {
  return tasks.get(name) ?? null;
}

export function isBusy(name) {
  const task = tasks.get(name);
  return Boolean(task) && !task.done;
}

export function getQueue(name) {
  return queues.get(name) ?? [];
}

function queueTask(cfg, { prompt, newSession, model, onDone, resumeSessionId, ticketId }) {
  const item = {
    id: randomUUID(),
    prompt,
    newSession: Boolean(newSession),
    model: model || null,
    onDone: onDone || null,
    resumeSessionId: resumeSessionId || null,
    ticketId: ticketId || null,
    queuedAt: Date.now(),
  };
  const q = queues.get(cfg.name) ?? [];
  q.push(item);
  queues.set(cfg.name, q);
  return item;
}

export function removeQueued(name, id) {
  const q = queues.get(name);
  if (!q) return false;
  const idx = q.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  q.splice(idx, 1);
  return true;
}

/**
 * 現在のタスクが終わった直後に呼ぶ。キューの先頭があれば自動で起動する。
 * キュー投入から起動までの間に設定UI で permissionMode 等が変わっている
 * 可能性があるので、実行中タスクの cfg をそのまま使い回さず読み直す。
 */
function startNextQueued(cfg) {
  const q = queues.get(cfg.name);
  if (!q || q.length === 0) return;
  const next = q.shift();
  const freshCfg = getContainerConfig(cfg.name) ?? cfg;
  startTask(freshCfg, {
    prompt: next.prompt,
    newSession: next.newSession,
    model: next.model,
    onDone: next.onDone,
    resumeSessionId: next.resumeSessionId,
    ticketId: next.ticketId,
  }).catch((err) => {
    // busy チェックとキュー投入は同期的に行っているため通常は起きないはずだが、
    // 念のため握りつぶさずログには残す。
    console.error(`[taskRunner] キュー投入タスクの起動に失敗しました (${cfg.name}): ${err.message}`);
  });
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

  emit(task, 'end', {
    exitCode: task.exitCode,
    error: task.error,
    durationMs: task.endedAt - task.startedAt,
    cancelled: task.cancelRequested,
  });

  for (const res of task.subscribers) {
    res.write(`event: closed\ndata: ${JSON.stringify({ exitCode: task.exitCode })}\n\n`);
    res.end();
  }
  task.subscribers.clear();

  // パイプライン機能（マスターによる自動判断）が「このタスクが本当に終わった」
  // タイミングをフックするための出口。呼び出し側の都合（ファイル書き込み・
  // 次タスク投入など）で例外を投げても、タスク自体の終了処理は壊さない。
  if (task.onDone) {
    try {
      task.onDone(task);
    } catch (err) {
      console.error(`[taskRunner] onDone コールバックが例外を投げました (${task.container}): ${err.message}`);
    }
  }
}

/**
 * コンテナ内で `claude -p` を起動し、stream-json の各行をイベントとして貯める。
 *
 * 同じコンテナで実行中のタスクがある場合、`enqueueIfBusy` が真ならキューに積んで
 * `{ queued: true, item }` を返す（呼び出し側が投入扱いにする）。偽なら例外を投げる
 * （呼び出し側が 409 にする）。現在のタスクが終わるたびにキューの先頭が自動起動される。
 */
export async function startTask(
  cfg,
  {
    prompt,
    newSession = false,
    model = null,
    enqueueIfBusy = false,
    onDone = null,
    resumeSessionId = null,
    ticketId = null,
  },
) {
  if (isBusy(cfg.name)) {
    if (enqueueIfBusy) {
      return {
        queued: true,
        item: queueTask(cfg, { prompt, newSession, model, onDone, resumeSessionId, ticketId }),
      };
    }
    const err = new Error('このコンテナでは既にタスクが実行中です');
    err.status = 409;
    throw err;
  }

  const resolvedModel = model || cfg.model || null;

  const task = {
    id: randomUUID(),
    container: cfg.name,
    prompt,
    model: resolvedModel,
    sessionId: null,
    sessionMode: null,
    startedAt: Date.now(),
    endedAt: null,
    done: false,
    cancelRequested: false,
    exitCode: null,
    error: null,
    usage: null,
    events: [],
    nextSeq: 0,
    dropped: 0,
    subscribers: new Set(),
    onDone,
    // パイプライン機能が「このタスクはどのチケットの一部か」を追跡するための印。
    // 手動でカードから投げたタスクは null のまま（パイプライン非依存）。
    ticketId,
  };
  // await を挟む前に枠を確保する。セッション解決を待ってから登録すると、
  // 同時に来たリクエストが両方とも isBusy を通過して二重起動する。
  tasks.set(cfg.name, task);

  let session;
  try {
    session = await resolveSession(cfg.name, cfg.workspacePath, { newSession, resumeId: resumeSessionId });
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
  if (resolvedModel) cmd.push('--model', resolvedModel);
  // 新規セッションは ID を先に固定でき、以降は同じ ID を resume できる。
  cmd.push(session.mode === 'new' ? '--session-id' : '--resume', session.id);

  emit(task, 'start', {
    prompt,
    model: resolvedModel,
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
      if (usage) {
        task.usage = usage;
        if (task.ticketId) recordTicketUsage(task.ticketId, usage);
      }

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
      // このコンテナ宛にキューされたタスクがあれば、間を置かず次を起動する。
      startNextQueued(cfg);
    });

  return task;
}

/**
 * 実行中のタスクを止める。同じコンテナでは isBusy により `claude -p` は常に
 * 高々 1 プロセスなので、コマンドラインの先頭一致で安全に対象を絞れる
 * （プロンプト文字列の中に同じ文字列が現れても、それは引数の途中なので
 * 先頭一致にはならない）。claude が起動した個々のツール実行（子プロセス）
 * までは追わない既知の制約がある。
 */
export async function cancelTask(cfg) {
  const task = tasks.get(cfg.name);
  if (!task || task.done) {
    const err = new Error('実行中のタスクはありません');
    err.status = 404;
    throw err;
  }

  if (!task.cancelRequested) {
    task.cancelRequested = true;
    emit(task, 'cancel', {});
    try {
      await execCapture(cfg.name, ['sh', '-c', "pkill -TERM -f '^claude -p ' || true"]);
    } catch (err) {
      emit(task, 'stderr', { text: `キャンセル処理に失敗しました: ${err.message}\n` });
    }
  }

  return task;
}

/** API レスポンス用の軽量スナップショット（events は含めない）。 */
export function snapshot(task) {
  if (!task) return null;
  return {
    id: task.id,
    container: task.container,
    prompt: task.prompt,
    model: task.model,
    sessionId: task.sessionId,
    sessionMode: task.sessionMode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    done: task.done,
    cancelRequested: task.cancelRequested,
    exitCode: task.exitCode,
    error: task.error,
    usage: task.usage,
    eventCount: task.events.length,
    ticketId: task.ticketId,
  };
}
