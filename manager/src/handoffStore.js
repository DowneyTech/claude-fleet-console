import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// docker-compose.yml で全プロジェクトコンテナ + manager に共通で
// `${HOME}/Project/.fleet-handoff:/handoff` としてマウントする、書き込み可能な
// 共有フォルダ。manager 自身もここへマウントしているので、コンテナが停止中でも
// fs で直接読み書きできる（docker exec に頼らない）。
const ROOT = process.env.HANDOFF_DIR ?? '/handoff';

const TICKET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ticketDir(id) {
  if (!TICKET_ID_RE.test(id)) {
    throw Object.assign(new Error('invalid ticket id'), { status: 400 });
  }
  return path.join(ROOT, id);
}

/** チケット作成時に呼ぶ。無ければ作る。 */
export function ensureTicketDir(id) {
  const dir = ticketDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listArtifacts(id) {
  const dir = ticketDir(id);
  try {
    return readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const st = statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .filter((f) => f.size >= 0 && !Number.isNaN(f.mtime))
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    // ディレクトリがまだ無い（=何も送信していない）だけの場合は空扱いにする。
    return [];
  }
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export function readArtifact(id, filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('/') || filename.includes('..')) {
    throw Object.assign(new Error('invalid filename'), { status: 400 });
  }
  const file = path.join(ticketDir(id), filename);
  const st = statSync(file);
  if (st.size > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error('ファイルが大きすぎます（2MB 超）'), { status: 413 });
  }
  return readFileSync(file, 'utf8');
}
