import { Router } from 'express';
import { requireContainer } from '../config.js';
import { inspect } from '../docker.js';
import { listSkills, writeSkill } from '../skillsStore.js';

const router = Router();

router.get('/:name/skills', requireContainer, async (req, res, next) => {
  try {
    const info = await inspect(req.containerConfig.name);
    if (!info || info.State.Status !== 'running') {
      return res.json({ skills: [] });
    }
    const skills = await listSkills(req.containerConfig.name, req.containerConfig.workspacePath);
    res.json({ skills });
  } catch (err) {
    next(err);
  }
});

router.post('/:name/skills', requireContainer, async (req, res, next) => {
  try {
    const info = await inspect(req.containerConfig.name);
    if (!info || info.State.Status !== 'running') {
      return res.status(409).json({ error: 'コンテナが起動していません' });
    }
    const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const result = await writeSkill(req.containerConfig.name, req.containerConfig.workspacePath, slug, content);
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
