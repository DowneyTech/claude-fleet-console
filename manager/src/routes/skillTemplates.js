import { Router } from 'express';
import { ROLE_SKILL_TEMPLATES } from '../skillsStore.js';

// containers.js の `/:name` に飲み込まれないよう、/api/containers とは別のパスで
// マウントする（skills.js 参照）。
const router = Router();

router.get('/', (_req, res) => {
  res.json({ templates: ROLE_SKILL_TEMPLATES });
});

export default router;
