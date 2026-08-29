import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// containers.config.json と同じ考え方: プロジェクトルートが読み書きマウントされて
// いれば（`.:/compose-project`）そちらへ保存し、manager コンテナの再作成後も
// テンプレートが残るようにする。無ければイメージ同梱のパスへフォールバックする。
const mountedDir = path.join(process.env.COMPOSE_PROJECT_DIR ?? '/compose-project', 'manager');

export const templatesPath = process.env.TEMPLATES_FILE
  ? path.resolve(process.env.TEMPLATES_FILE)
  : existsSync(mountedDir)
    ? path.join(mountedDir, 'templates.json')
    : path.join(appRoot, 'templates.json');

function load() {
  if (!existsSync(templatesPath)) return [];
  try {
    const data = JSON.parse(readFileSync(templatesPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    // 書き込み途中などで壊れた状態を一瞬読んでしまった場合は空として扱う。
    return [];
  }
}

function save(list) {
  writeFileSync(templatesPath, `${JSON.stringify(list, null, 2)}\n`);
}

export function listTemplates() {
  return load();
}

export function addTemplate({ title, prompt }) {
  if (typeof title !== 'string' || !title.trim()) {
    throw Object.assign(new Error('title が必要です'), { status: 400 });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt が必要です'), { status: 400 });
  }

  const list = load();
  const entry = { id: randomUUID(), title: title.trim(), prompt, createdAt: Date.now() };
  list.push(entry);
  save(list);
  return entry;
}

export function removeTemplate(id) {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) {
    throw Object.assign(new Error(`未登録のテンプレートです: ${id}`), { status: 404 });
  }
  save(next);
}
