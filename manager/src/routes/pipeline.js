import { Router } from 'express';
import {
  advanceTicket,
  createTicket,
  getTicket,
  listTickets,
  rejectTicket,
  removeTicket,
  sendCurrentStage,
  stagesInfo,
} from '../pipelineStore.js';
import { listArtifacts, readArtifact } from '../handoffStore.js';

const router = Router();

function handleStoreError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

router.get('/stages', (_req, res) => res.json({ stages: stagesInfo() }));

router.get('/tickets', (_req, res) => res.json({ tickets: listTickets() }));

router.post('/tickets', (req, res, next) => {
  try {
    res.status(201).json(createTicket({ title: req.body?.title }));
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

router.delete('/tickets/:id', (req, res, next) => {
  try {
    removeTicket(req.params.id);
    res.status(204).end();
  } catch (err) {
    handleStoreError(err, res, next);
  }
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
