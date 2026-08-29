import { Router } from 'express';
import { requireContainer } from '../config.js';
import {
  authStatus,
  cancelLogin,
  loginView,
  logout,
  startLogin,
  submitCode,
} from '../authFlow.js';
import { isBusy } from '../taskRunner.js';

const router = Router();

router.get('/:name/auth', requireContainer, async (req, res, next) => {
  try {
    res.json({
      ...(await authStatus(req.containerConfig.name)),
      login: loginView(req.containerConfig.name),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:name/auth/login', requireContainer, async (req, res, next) => {
  const cfg = req.containerConfig;
  if (isBusy(cfg.name)) {
    return res.status(409).json({ error: 'タスク実行中はログインできません' });
  }
  try {
    res.json(await startLogin(cfg));
  } catch (err) {
    next(err);
  }
});

router.get('/:name/auth/login', requireContainer, (req, res) => {
  res.json(loginView(req.containerConfig.name));
});

/**
 * 利用者が自分で貼り付けた認証コードを受け取り、そのまま CLI の stdin へ渡す。
 * 保存もログ出力もしないので、レスポンスにもコードは含めない。
 */
router.post('/:name/auth/code', requireContainer, (req, res, next) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    return res.status(400).json({ error: 'コードが空です' });
  }
  try {
    res.json(submitCode(req.containerConfig.name, code));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:name/auth/login', requireContainer, async (req, res, next) => {
  try {
    res.json(await cancelLogin(req.containerConfig.name));
  } catch (err) {
    next(err);
  }
});

router.post('/:name/auth/logout', requireContainer, async (req, res, next) => {
  try {
    res.json(await logout(req.containerConfig.name));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
