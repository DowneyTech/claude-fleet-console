import { Router } from 'express';
import {
  addProject,
  applyCompose,
  getComposeView,
  MODEL_PRESETS,
  PERMISSION_MODES,
  ROLE_PRESETS,
  updateProjectMeta,
  updateWorkspaceHostPath,
} from '../composeStore.js';

const router = Router();

router.get('/projects', (_req, res, next) => {
  try {
    res.json(getComposeView());
  } catch (err) {
    next(err);
  }
});

router.post('/projects', (req, res, next) => {
  try {
    const { name, displayName, hostPath, permissionMode, allowedTools, model, role, requiresApproval } = req.body ?? {};
    addProject({ name, displayName, hostPath, permissionMode, allowedTools, model, role, requiresApproval });
    res.status(201).json(getComposeView());
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:name', (req, res, next) => {
  try {
    const { hostPath, displayName, permissionMode, allowedTools, model, role, requiresApproval } = req.body ?? {};
    if (hostPath !== undefined) updateWorkspaceHostPath(req.params.name, hostPath);
    if (
      displayName !== undefined ||
      permissionMode !== undefined ||
      allowedTools !== undefined ||
      model !== undefined ||
      role !== undefined ||
      requiresApproval !== undefined
    ) {
      updateProjectMeta(req.params.name, { displayName, permissionMode, allowedTools, model, role, requiresApproval });
    }
    res.json(getComposeView());
  } catch (err) {
    next(err);
  }
});

router.get('/permission-modes', (_req, res) => {
  res.json({ modes: PERMISSION_MODES });
});

router.get('/models', (_req, res) => {
  res.json({ presets: MODEL_PRESETS });
});

router.get('/role-presets', (_req, res) => {
  res.json({ presets: ROLE_PRESETS });
});

router.post('/apply', async (req, res, next) => {
  try {
    const build = Boolean(req.body?.build);
    const service = typeof req.body?.service === 'string' ? req.body.service : null;
    // 失敗時も docker compose の出力（原因の手がかり）をそのまま返したいので、
    // ここでは常に 200 を返し、成否は body.ok で表す。
    res.json(await applyCompose({ build, service }));
  } catch (err) {
    next(err);
  }
});

export default router;
