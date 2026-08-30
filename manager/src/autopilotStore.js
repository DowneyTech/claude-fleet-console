import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// パイプライン全体の自動運転（マスターによる自動判断）を、チケットごとではなく
// 一括で止めたいときのためのグローバルなスイッチ。他の *Store.js と同じ考え方で、
// プロジェクトルートが読み書きマウントされていればそちらへ保存する。
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const mountedDir = path.join(process.env.COMPOSE_PROJECT_DIR ?? '/compose-project', 'manager');

export const autopilotPath = process.env.AUTOPILOT_FILE
  ? path.resolve(process.env.AUTOPILOT_FILE)
  : existsSync(mountedDir)
    ? path.join(mountedDir, 'autopilot.json')
    : path.join(appRoot, 'autopilot.json');

function load() {
  if (!existsSync(autopilotPath)) return { paused: false };
  try {
    const data = JSON.parse(readFileSync(autopilotPath, 'utf8'));
    return { paused: Boolean(data?.paused) };
  } catch {
    return { paused: false };
  }
}

export function isAutopilotPaused() {
  return load().paused;
}

export function setAutopilotPaused(paused) {
  writeFileSync(autopilotPath, `${JSON.stringify({ paused: Boolean(paused) }, null, 2)}\n`);
}
