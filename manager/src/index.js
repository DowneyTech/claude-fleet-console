import { timingSafeEqual } from 'node:crypto';
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

/**
 * CSRF 対策。この manager は認証機構を持たず 127.0.0.1 限定公開だけで守っている
 * ため、上の Host チェック（DNS リバインディング対策）だけでは、悪意ある
 * Web ページが同じブラウザから直接 http://localhost:4590/... へ送るリクエスト
 * を防げない（Host ヘッダは常に正しく 'localhost:4590' になるため）。単純な
 * <form method=POST> はカスタムヘッダを付けられないので、状態変更系
 * （GET/HEAD/OPTIONS 以外）のリクエストに専用ヘッダを必須にすることで弾く。
 * fetch で偽装しようとしても、cross-origin かつ 'application/json' のような
 * 非単純ヘッダを伴うと CORS プリフライトが必要になり、こちらは許可レスポンス
 * を返さないためブラウザ側でブロックされる。
 * あわせて、モダンブラウザが自動付与する Sec-Fetch-Site（改ざん不可）で
 * cross-site/same-site を明示的に拒否する（フォーム送信にも付くため二重の防御になる）。
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUIRED_HEADER = 'x-fleet-console';
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'forbidden (cross-site request)' });
  }
  if (req.headers[REQUIRED_HEADER] !== '1') {
    return res.status(403).json({ error: 'forbidden (missing required header)' });
  }
  next();
});

/**
 * 任意のローカル共有トークン認証。既定では無効（今までどおり 127.0.0.1 限定公開 +
 * 上記の CSRF 対策のみ）。SSH トンネル越しなど、127.0.0.1 以外の経路から
 * manager に到達しうる運用をする場合の追加の保険として、FLEET_CONSOLE_TOKEN を
 * 設定すると /api への全リクエストにこのトークンを要求するようになる。
 * EventSource はブラウザの仕様上カスタムヘッダを送れないため、クエリ文字列
 * （?token=）でも受け付ける（値そのものは秘密情報だが、127.0.0.1 限定公開が
 * 前提の個人利用ツールという性質上、アクセスログへの残留は許容している）。
 */
const CONSOLE_TOKEN = process.env.FLEET_CONSOLE_TOKEN || null;

function timingSafeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  // 長さが違うと timingSafeEqual 自体が例外を投げるため、先に弾く
  // （長さの違いが漏れても、トークン自体の長さは秘密ではないので問題ない）。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

if (CONSOLE_TOKEN) {
  app.use('/api', (req, res, next) => {
    const provided = req.headers['x-fleet-token'] ?? req.query.token;
    if (typeof provided !== 'string' || !timingSafeTokenEqual(provided, CONSOLE_TOKEN)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  console.log('[manager] FLEET_CONSOLE_TOKEN が設定されているため、/api への全アクセスにトークンを要求します。');
}

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
