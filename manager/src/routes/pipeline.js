import { Router } from 'express';
import { isAutopilotPaused, setAutopilotPaused } from '../autopilotStore.js';
import {
  advanceTicket,
  createTicket,
  getTicket,
  listTickets,
  masterInfo,
  rejectTicket,
  removeTicket,
  sendCurrentStage,
  stagesInfo,
} from '../pipelineStore.js';
import { listArtifacts, readArtifact } from '../handoffStore.js';
import { usageForTicket } from '../usageStore.js';

const router = Router();

function handleStoreError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

router.get('/stages', (_req, res) => res.json({ stages: stagesInfo() }));

router.get('/master', (_req, res) => res.json(masterInfo()));

router.get('/autopilot', (_req, res) => res.json({ paused: isAutopilotPaused() }));

router.post('/autopilot', (req, res) => {
  setAutopilotPaused(Boolean(req.body?.paused));
  res.json({ paused: isAutopilotPaused() });
});

router.get('/tickets', (_req, res) => res.json({ tickets: listTickets() }));

router.post('/tickets', async (req, res, next) => {
  try {
    res.status(201).json(await createTicket({ title: req.body?.title }));
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.get('/tickets/:id', (req, res, next) => {
  try {
    res.json(getTicket(req.params.id));
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.delete('/tickets/:id', async (req, res, next) => {
  try {
    await removeTicket(req.params.id);
    res.status(204).end();
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.get('/tickets/:id/usage', (req, res) => {
  res.json(usageForTicket(req.params.id));
});

router.post('/tickets/:id/send', async (req, res, next) => {
  try {
    res.json(await sendCurrentStage(req.params.id, req.body?.note));
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.post('/tickets/:id/advance', async (req, res, next) => {
  try {
    res.json(await advanceTicket(req.params.id, req.body?.note));
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.post('/tickets/:id/reject', async (req, res, next) => {
  try {
    res.json(await rejectTicket(req.params.id, req.body?.toStage, req.body?.note));
  } catch (err) {
    handleStoreError(err, res, next);
  }
});

router.get('/tickets/:id/artifacts', (req, res) => {
  res.json({ artifacts: listArtifacts(req.params.id) });
});

router.get('/tickets/:id/artifacts/:filename', (req, res, next) => {
  try {
    res.json({ content: readArtifact(req.params.id, req.params.filename) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'ファイルが見つかりません' });
    handleStoreError(err, res, next);
  }
});

export default router;
