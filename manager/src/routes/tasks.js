import { Router } from 'express';
import { isLoggingIn } from '../authFlow.js';
import { requireContainer } from '../config.js';
import { getTask, snapshot, startTask, subscribe } from '../taskRunner.js';

const router = Router();

router.post('/:name/tasks', requireContainer, async (req, res, next) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ error: 'prompt が空です' });
  }

  if (isLoggingIn(req.containerConfig.name)) {
    return res.status(409).json({ error: 'ログイン処理中はタスクを投入できません' });
  }

  try {
    const task = await startTask(req.containerConfig, {
      prompt,
      newSession: Boolean(req.body?.newSession),
    });
    res.status(202).json(snapshot(task));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
