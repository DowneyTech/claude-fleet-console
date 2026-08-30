import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// 設定UI からの書き込みはホストの実ファイル（git 管理下）に対して行いたいので、
// `.:/compose-project` がマウントされていればそちらを優先する。無ければ
// イメージにビルド時 COPY された同梱コピーへフォールバックする（読み取り専用運用向け）。
const mountedConfigPath = path.join(
  process.env.COMPOSE_PROJECT_DIR ?? '/compose-project',
  'manager',
  'containers.config.json',
);

export const configPath = process.env.CONTAINERS_CONFIG
  ? path.resolve(process.env.CONTAINERS_CONFIG)
  : existsSync(mountedConfigPath)
    ? mountedConfigPath
    : path.join(appRoot, 'containers.config.json');

function parse(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`${configPath} は配列である必要があります`);
  }
  return data.map((entry) => {
    if (!entry.name) throw new Error(`${configPath}: name の無いエントリがあります`);
    return {
      name: entry.name,
      displayName: entry.displayName ?? entry.name,
      workspacePath: entry.workspacePath ?? '/workspace',
      permissionMode: entry.permissionMode ?? 'bypassPermissions',
      allowedTools: entry.allowedTools ?? null,
      model: entry.model ?? null,
      // パイプライン機能（設計/実装/レビュー/テスト）でどの工程を担当するかの印。
      // 任意項目。未設定なら他機能から役割ベースで名指しされることはない。
      role: entry.role ?? null,
      // true の場合、マスターの自動判断だけではこの工程へ進めず、人間が
      // 手動で「次工程へ」を押すまで待つ（＝破壊的な変更をしうる工程の手前に
      // 承認チェックポイントを残すためのフラグ）。
      requiresApproval: Boolean(entry.requiresApproval),
    };
  });
}

let cache = { at: 0, mtimeMs: 0, containers: parse(readFileSync(configPath, 'utf8')) };

/**
 * 設定UI からの追加・編集を再起動なしで反映するため、ファイルの更新時刻を見て
 * 変わっていれば読み直す。ポーリング間隔（5秒）ごとに呼ばれる程度の頻度なので
 * 都度 stat してもコストは無視できる。
 */
function reload() {
  let mtimeMs;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch {
    return cache.containers; // 一時的に読めない場合は前回値を使う。
  }
  if (mtimeMs === cache.mtimeMs) return cache.containers;

  try {
    const containers = parse(readFileSync(configPath, 'utf8'));
    cache = { at: Date.now(), mtimeMs, containers };
  } catch {
    // 書き込み途中などで壊れた状態を一瞬読んでしまった場合は前回値を使う。
  }
  return cache.containers;
}

export const publicDir = path.join(appRoot, 'public');

export function listContainerConfigs() {
  return reload();
}

export function getContainerConfig(name) {
  return reload().find((c) => c.name === name) ?? null;
}

/** :name をレジストリと突き合わせ、req.containerConfig に載せる。 */
export function requireContainer(req, res, next) {
  const cfg = getContainerConfig(req.params.name);
  if (!cfg) {
    return res.status(404).json({ error: `未登録のコンテナです: ${req.params.name}` });
  }
  req.containerConfig = cfg;
  next();
}
