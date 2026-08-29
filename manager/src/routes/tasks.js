import { Router } from 'express';
import { isLoggingIn } from '../authFlow.js';
import { requireContainer } from '../config.js';
import { validateModel } from '../composeStore.js';
import { cancelTask, getQueue, getTask, removeQueued, snapshot, startTask, subscribe } from '../taskRunner.js';

const router = Router();

router.post('/:name/tasks', requireContainer, async (req, res, next) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ error: 'prompt が空です' });
  }

  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (model && !validateModel(model)) {
    return res.status(400).json({ error: 'model が不正です' });
  }

  if (isLoggingIn(req.containerConfig.name)) {
    return res.status(409).json({ error: 'ログイン処理中はタスクを投入できません' });
  }

  try {
    // busy なコンテナへの投入は自動でキューに積む（現在のタスク完了後に自動起動）。
    const result = await startTask(req.containerConfig, {
      prompt,
      newSession: Boolean(req.body?.newSession),
      model: model || null,
      enqueueIfBusy: true,
    });
    res.status(202).json(result.queued ? result : snapshot(result));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:name/task', requireContainer, async (req, res, next) => {
  try {
    const task = await cancelTask(req.containerConfig);
    res.json(snapshot(task));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/:name/tasks/queue', requireContainer, (req, res) => {
  res.json({ queue: getQueue(req.containerConfig.name) });
});

router.delete('/:name/tasks/queue/:id', requireContainer, (req, res) => {
  const ok = removeQueued(req.containerConfig.name, req.params.id);
  if (!ok) return res.status(404).json({ error: 'キュー内に見つかりません' });
  res.json({ queue: getQueue(req.containerConfig.name) });
});

router.get('/:name/task', requireContainer, (req, res) => {
  const task = getTask(req.containerConfig.name);
  if (!task) return res.status(404).json({ error: 'このコンテナのタスク履歴はまだありません' });
  res.json(snapshot(task));
});

router.get('/:name/task/stream', requireContainer, (req, res) => {
  const task = getTask(req.containerConfig.name);

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  if (!task) {
    res.write('event: closed\ndata: {"reason":"no-task"}\n\n');
    return res.end();
  }

  // プロキシやブラウザに接続を切られないよう、無音時も心拍を送る。
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => clearInterval(heartbeat));

  subscribe(task, res);
});

export default router;
