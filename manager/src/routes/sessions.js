import { Router } from 'express';
import { requireContainer } from '../config.js';
import { readSession } from '../history.js';
import { getCurrent, listSessions } from '../sessionStore.js';

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
