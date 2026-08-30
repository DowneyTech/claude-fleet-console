import { randomUUID } from 'node:crypto';
import { execCapture } from './docker.js';

// コンテナ名 → 現在のセッション UUID。プロセス内メモリのみ（再起動で失われるが、
// その場合は下の探索フローが実ファイルから拾い直す）。
const current = new Map();

export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Claude Code は cwd の "/" を "-" に置換したものをプロジェクトのディレクトリ名に使う。 */
export function slugFor(workspacePath) {
  return workspacePath.replace(/\//g, '-');
}

export function sessionDir(workspacePath) {
  return `/home/claude/.claude/projects/${slugFor(workspacePath)}`;
}

export function getCurrent(name) {
  return current.get(name) ?? null;
}

export function setCurrent(name, sessionId) {
  current.set(name, sessionId);
}

export function clearCurrent(name) {
  current.delete(name);
}

const writableCache = new Map(); // コンテナ名 → { at, value }
const WRITABLE_TTL_MS = 60_000;

/**
 * 設定ディレクトリに書き込めるか。
 *
 * イメージ内に /home/claude/.claude が無いと、Docker が名前付きボリュームの
 * マウント先を root 所有で作ってしまい、claude ユーザーが書けなくなる。
 * この状態だと認証情報もセッション履歴も一切保存されないのに、CLI は
 * 静かに失敗するだけなので、ダッシュボードで明示的に警告する。
 */
export async function configWritable(name) {
  const cached = writableCache.get(name);
  if (cached && Date.now() - cached.at < WRITABLE_TTL_MS) return cached.value;

  try {
    const { exitCode } = await execCapture(name, [
      'test', '-w', '/home/claude/.claude',
    ]);
    // 終了コードが確定したときだけ結果として扱う。
    if (exitCode === 0 || exitCode === 1) {
      const value = exitCode === 0;
      writableCache.set(name, { at: Date.now(), value });
      return value;
    }
  } catch {
    /* 起動直後で exec を受け付けない等の一時的な失敗。 */
  }

  // 一時的な失敗を「書き込み不可」として 60 秒キャッシュすると、
  // 健全なコンテナに警告バナーが出続けてしまう。前回値があればそれを返し、
  // 無ければ楽観的に true を返してキャッシュしない。
  return cached?.value ?? true;
}

/** コンテナ内のセッション jsonl を新しい順に列挙する。 */
export async function listSessions(name, workspacePath) {
  const dir = sessionDir(workspacePath);
  // busybox の ls には --time-style が無いので stat を使う。
  const { stdout } = await execCapture(name, [
    'sh',
    '-c',
    `stat -c '%Y %s %n' ${dir}/*.jsonl 2>/dev/null || true`,
  ]);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [mtime, size, ...rest] = line.split(' ');
      const filePath = rest.join(' ');
      const id = filePath.split('/').pop().replace(/\.jsonl$/, '');
      return {
        id,
        path: filePath,
        bytes: Number(size) || 0,
        mtime: (Number(mtime) || 0) * 1000,
      };
    })
    .filter((s) => SESSION_ID_RE.test(s.id))
    .sort((a, b) => b.mtime - a.mtime);
}

/** 直近に更新されたセッション（＝そのコンテナの「最終活動時刻」の根拠）。 */
export async function latestSession(name, workspacePath) {
  const sessions = await listSessions(name, workspacePath).catch(() => []);
  return sessions[0] ?? null;
}

/**
 * タスク投入に使うセッション ID を決める。
 *   ① resumeId が指定され、実ファイルとして存在すれば必ずそれを --resume する
 *   ② 指定が無ければメモリ上の既知 ID（＝コンテナの「現在のセッション」）を --resume
 *   ③ それも無ければコンテナ内の最新 jsonl（人間が手動対話したもの）を --resume
 *   ④ どれも無ければ新規 UUID を発行して --session-id で開始
 * newSession が真なら ①〜③ を飛ばして常に ④。
 *
 * resumeId は「このコンテナの現在のセッション」という単一のグローバルな状態に
 * 頼らず、呼び出し側（パイプラインの各チケット×工程など）が「前回自分が
 * 使ったセッション」を名指しで再開したいときに使う。複数の作業（チケット）が
 * 同じコンテナ＝同じ役割を使い回す場合、単なる「現在のセッション」だけでは
 * 別の作業の文脈を resume してしまう事故が起きるため。
 *
 * ①③ で実ファイルを確認するのは、前回のタスクがセッション作成前に失敗した場合や
 * ボリュームを消した場合に、存在しない ID を resume して連続失敗する
 * （resumeId の場合は無関係な別セッションを誤って resume する）のを防ぐため。
 */
export async function resolveSession(name, workspacePath, { newSession = false, resumeId = null } = {}) {
  if (newSession) {
    const id = randomUUID();
    current.set(name, id);
    return { id, mode: 'new' };
  }

  const sessions = await listSessions(name, workspacePath).catch(() => []);

  if (resumeId) {
    if (sessions.some((s) => s.id === resumeId)) {
      current.set(name, resumeId);
      return { id: resumeId, mode: 'resume' };
    }
    // 指定されたセッションが実ファイルとして残っていない（消えた等）場合、
    // 無関係な別セッション（現在のセッションや最新ファイル）を resume してしまうと
    // 別の作業の文脈が混ざる事故になるので、素直に新規発行へフォールバックする。
    const id = randomUUID();
    current.set(name, id);
    return { id, mode: 'new' };
  }

  const known = current.get(name);
  if (known && sessions.some((s) => s.id === known)) {
    return { id: known, mode: 'resume' };
  }

  if (sessions.length > 0) {
    current.set(name, sessions[0].id);
    return { id: sessions[0].id, mode: 'resume' };
  }

  const id = randomUUID();
  current.set(name, id);
  return { id, mode: 'new' };
}
