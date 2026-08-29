import { Router } from 'express';
import { requireContainer } from '../config.js';
import { readSession } from '../history.js';
import { getCurrent, listSessions, setCurrent } from '../sessionStore.js';
import { isBusy } from '../taskRunner.js';

const router = Router();

router.get('/:name/sessions', requireContainer, async (req, res, next) => {
  const cfg = req.containerConfig;
  try {
    const sessions = await listSessions(cfg.name, cfg.workspacePath);
    res.json({ sessions, currentSessionId: getCurrent(cfg.name) });
  } catch (err) {
    next(err);
  }
});

/**
 * 次のタスク投入で resume するセッションを、一覧の中の任意の 1 件に切り替える。
 * 実行中のタスクがある間は、そのタスクが --resume している ID を横から
 * 書き換えてしまうと次回投入時に食い違うため拒否する。
 */
router.post('/:name/sessions/:sessionId/resume', requireContainer, async (req, res, next) => {
  const cfg = req.containerConfig;
  if (isBusy(cfg.name)) {
    return res.status(409).json({ error: 'タスク実行中はセッションを切り替えられません' });
  }
  try {
    const sessions = await listSessions(cfg.name, cfg.workspacePath);
    if (!sessions.some((s) => s.id === req.params.sessionId)) {
      return res.status(404).json({ error: 'そのセッションは見つかりません' });
    }
    setCurrent(cfg.name, req.params.sessionId);
    res.json({ currentSessionId: req.params.sessionId });
  } catch (err) {
    next(err);
  }
});

router.get('/:name/sessions/:sessionId', requireContainer, async (req, res, next) => {
  const cfg = req.containerConfig;
  try {
    res.json(await readSession(cfg.name, cfg.workspacePath, req.params.sessionId));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
