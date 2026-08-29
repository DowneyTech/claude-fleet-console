import { Router } from 'express';
import { requireContainer } from '../config.js';
import { inspect } from '../docker.js';
import { listSkills } from '../skillsStore.js';

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

export default router;
