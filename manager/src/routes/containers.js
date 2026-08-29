import { Router } from 'express';
import { authStatus, loginView } from '../authFlow.js';
import { listContainerConfigs, requireContainer } from '../config.js';
import { inspect, lifecycle } from '../docker.js';
import { configWritable, latestSession } from '../sessionStore.js';
import { getTask, isBusy, snapshot } from '../taskRunner.js';
import { fleetUsage, onUsageChange, rateLimitsFor, resetUsage, usageFor } from '../usageStore.js';

const router = Router();

const RECENT_WINDOW_MS = 2 * 60 * 1000;

function classify({ state, busy, lastActivity }) {
  if (state === 'missing') return 'missing';
  // busy を先に見る。実行中のタスクを残したままコンテナが落ちた場合に
  // 「停止中」と「実行中」が同時に表示されるのを避ける。
  if (busy) return 'working';
  if (state !== 'running') return 'stopped';
  if (lastActivity && Date.now() - lastActivity < RECENT_WINDOW_MS) return 'recent';
  return 'idle';
}

async function describe(cfg) {
  const info = await inspect(cfg.name);
  const state = info ? info.State.Status : 'missing';
  const busy = isBusy(cfg.name);

  // 停止中のコンテナには exec できないので、活動時刻と認証状態の取得は起動中だけ。
  let session = null;
  let auth = { loggedIn: false, authMethod: 'unknown', apiProvider: null };
  let writable = true;
  if (state === 'running') {
    [session, auth, writable] = await Promise.all([
      latestSession(cfg.name, cfg.workspacePath).catch(() => null),
      authStatus(cfg.name),
      configWritable(cfg.name).catch(() => true),
    ]);
  }

  const lastActivity = session?.mtime ?? null;

  // ホスト側のどのフォルダを参照しているか（workspace / vault のマウント元）。
  // docker inspect の実マウントを見るので、compose ファイルをまだ適用していない
  // 変更中の値ではなく、実際に今動いている値を返す。
  const mounts = (info?.Mounts ?? [])
    .filter((m) => m.Destination === cfg.workspacePath || m.Destination === '/vault')
    .map((m) => ({ destination: m.Destination, source: m.Source, readOnly: !m.RW }));

  return {
    name: cfg.name,
    displayName: cfg.displayName,
    workspacePath: cfg.workspacePath,
    permissionMode: cfg.permissionMode,
    mounts,
    state,
    activity: classify({ state, busy, lastActivity }),
    busy,
    startedAt: info?.State?.StartedAt ? Date.parse(info.State.StartedAt) : null,
    lastActivity,
    latestSessionId: session?.id ?? null,
    task: snapshot(getTask(cfg.name)),
    auth,
    configWritable: writable,
    login: loginView(cfg.name),
    usage: usageFor(cfg.name),
    rateLimits: rateLimitsFor(cfg.name),
  };
}

/** ヘッダー表示に必要な分だけの軽量スナップショット（SSE と GET / の両方で使う）。 */
function usageSnapshot() {
  return {
    usage: fleetUsage(),
    containers: listContainerConfigs().map((cfg) => ({
      name: cfg.name,
      displayName: cfg.displayName,
      rateLimits: rateLimitsFor(cfg.name),
    })),
  };
}

router.get('/', async (_req, res, next) => {
  try {
    const containers = await Promise.all(listContainerConfigs().map(describe));
    res.json({ containers, usage: fleetUsage(), now: Date.now() });
  } catch (err) {
    next(err);
  }
});

/**
 * ヘッダー（コスト・トークン・レート上限）専用の SSE。
 * 5 秒ポーリングを待たず、CLI が値を返した直後に配信する。
 * `/:name` より前に置く。メソッドが違うので衝突はしないが、意図を明示しておく。
 */
router.get('/usage/stream', (_req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = () => res.write(`event: snapshot\ndata: ${JSON.stringify(usageSnapshot())}\n\n`);
  send(); // 初回接続時点の状態をまず渡す。

  const unsubscribe = onUsageChange(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.delete('/usage', (_req, res) => {
  resetUsage();
  res.json({ usage: fleetUsage() });
});

router.delete('/:name/usage', requireContainer, (req, res) => {
  resetUsage(req.containerConfig.name);
  res.json({ usage: usageFor(req.containerConfig.name) });
});

router.get('/:name', requireContainer, async (req, res, next) => {
  try {
    res.json(await describe(req.containerConfig));
  } catch (err) {
    next(err);
  }
});

for (const action of ['start', 'stop', 'restart']) {
  router.post(`/:name/${action}`, requireContainer, async (req, res, next) => {
    try {
      await lifecycle(req.containerConfig.name, action);
      res.json(await describe(req.containerConfig));
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: 'コンテナが未作成です。docker compose up -d を先に実行してください。' });
      }
      // 既に起動済み / 停止済みなど、状態が要求と一致しない場合。
      if (err.statusCode === 304) {
        return res.json(await describe(req.containerConfig));
      }
      next(err);
    }
  });
}

export default router;
