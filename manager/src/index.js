import express from 'express';
import authRouter from './routes/auth.js';
import { listContainerConfigs, publicDir } from './config.js';
import { startPolling } from './remoteUsage.js';
import configRouter from './routes/config.js';
import containersRouter from './routes/containers.js';
import pipelineRouter from './routes/pipeline.js';
import sessionsRouter from './routes/sessions.js';
import skillsRouter from './routes/skills.js';
import skillTemplatesRouter from './routes/skillTemplates.js';
import tasksRouter from './routes/tasks.js';
import templatesRouter from './routes/templates.js';

const app = express();
app.disable('x-powered-by');

// DNS リバインディング対策。外部サイトが名前解決を 127.0.0.1 に向けても、
// Host ヘッダがループバックでなければ弾く。
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
app.use((req, res, next) => {
  // IPv6 リテラルは "[::1]:4590" の形で来るので、":" 単純分割では壊れる。
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    return res.status(403).json({ error: 'forbidden host' });
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

// いずれも /api/containers 配下。パスが重ならないので同じ mount point に並べられる。
app.use('/api/containers', containersRouter);
app.use('/api/containers', tasksRouter);
app.use('/api/containers', sessionsRouter);
app.use('/api/containers', authRouter);
app.use('/api/containers', skillsRouter);
app.use('/api/config', configRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/skill-templates', skillTemplatesRouter);

app.use(express.static(publicDir));

app.use((err, _req, res, _next) => {
  console.error('[manager]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'internal error' });
});

const port = Number(process.env.PORT ?? 4590);
app.listen(port, () => {
  const names = listContainerConfigs().map((c) => c.name).join(', ');
  console.log(`[manager] listening on :${port}`);
  console.log(`[manager] containers: ${names}`);
});

// レート上限（5時間 / 週）は Anthropic のアカウント別使用状況 API を
// 定期ポーリングして取得する。タスクの有無に関係なく最新値が分かる。
startPolling();
