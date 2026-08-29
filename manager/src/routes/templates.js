import { Router } from 'express';
import { addTemplate, listTemplates, removeTemplate } from '../templateStore.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ templates: listTemplates() });
});

router.post('/', (req, res, next) => {
  try {
    const { title, prompt } = req.body ?? {};
    res.status(201).json(addTemplate({ title, prompt }));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    removeTemplate(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
