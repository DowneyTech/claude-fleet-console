import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { configPath, getContainerConfig, listContainerConfigs } from './config.js';
import { inspect as inspectContainer } from './docker.js';

const execFileAsync = promisify(execFile);

// manager コンテナに読み書き可能でマウントしたプロジェクトルート（docker-compose.yml の場所）。
// docker-compose.yml 側で `.:/compose-project` としてマウントする。
const PROJECT_ROOT = process.env.COMPOSE_PROJECT_DIR ?? '/compose-project';
const COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

/**
 * 設計・実装・レビュー・テストのように役割特化でプロジェクトを分ける運用向けの
 * permissionMode / allowedTools のプリセット。containers.config.json の role に
 * 対応する。「設定 UI からワンクリックで適用する」ためのものであり、適用後も
 * 通常どおり個別に上書きできる（強制ではない）。
 */
export const ROLE_PRESETS = {
  design: {
    label: '設計',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch'],
  },
  implement: {
    label: '実装',
    permissionMode: 'bypassPermissions',
    allowedTools: [],
  },
  review: {
    // plan モードはツールを実行せず計画止まりになるため、コードを直接編集
    // させたくないレビュー役に向く。allowedTools も読み取り系のみに絞る。
    label: 'レビュー',
    permissionMode: 'plan',
    allowedTools: ['Read', 'Grep', 'Glob'],
  },
  test: {
    label: 'テスト',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
  },
};

export const ROLES = Object.keys(ROLE_PRESETS);

// UI の既定モデル選択肢。CLI 自体はフル ID（例: claude-opus-5）も受け付けるので、
// ここに無い値も MODEL_RE を満たせば --model にそのまま渡す（拒否はしない）。
export const MODEL_PRESETS = ['opus', 'sonnet', 'haiku'];
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/;

export function validateModel(value) {
  return typeof value === 'string' && MODEL_RE.test(value);
}

const NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
// ${HOME}/foo のような変数展開と絶対パスのみ許可。シェル的に危険な文字は拒否する
// （このパスはテキストとして compose ファイルへ書き戻すだけで、シェル評価はしない）。
const HOST_PATH_RE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\/)[A-Za-z0-9_.\-/${}]*$/;

function readText() {
  return readFileSync(COMPOSE_PATH, 'utf8');
}

/**
 * compose ファイル中の `${HOME}` を、実際のホストの $HOME で展開する。
 * manager コンテナ自身の HOME はホストの $HOME と一致しないため、applyCompose
 * と同じ理由で HOST_HOME を使う（docker-compose.yml の manager サービスに設定済み）。
 * HOST_HOME が未設定なら展開できないので、変数のまま返す。
 */
export function expandHostHome(rawPath) {
  if (typeof rawPath !== 'string') return rawPath;
  const hostHome = process.env.HOST_HOME;
  if (!hostHome) return rawPath;
  return rawPath.replace(/\$\{HOME\}/g, hostHome).replace(/\$HOME\b/g, hostHome);
}

function writeText(text) {
  writeFileSync(COMPOSE_PATH, text);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** サービス名の行（"  <name>:"）から次の兄弟キーの直前までを 1 ブロックとして返す。 */
function findBlock(lines, startIdx) {
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) || /^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: startIdx, end };
}

function findServiceLineIndex(lines, serviceName) {
  const re = new RegExp(`^ {2}${escapeRegex(serviceName)}:\\s*$`);
  return lines.findIndex((l) => re.test(l));
}

/** ブロック内の volumes リストから、指定コンテナパスへのマウント行を探す。 */
function findVolumeLine(lines, block, containerPath) {
  const re = new RegExp(`^(\\s*-\\s*)(.+):${escapeRegex(containerPath)}(:.*)?\\s*$`);
  for (let i = block.start; i < block.end; i += 1) {
    const m = lines[i].match(re);
    if (m) return { index: i, prefix: m[1], suffix: m[3] ?? '' };
  }
  return null;
}

/** depends_on: のようなリストキーの最後の項目の直後に新しい項目を挿入する。 */
function appendListItem(lines, block, keyRe, newItemName) {
  let keyIdx = -1;
  for (let i = block.start; i < block.end; i += 1) {
    if (keyRe.test(lines[i])) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) return; // キーが無ければ何もしない（無ければ壊さない方を優先）。

  let indent = null;
  let lastIdx = keyIdx;
  for (let i = keyIdx + 1; i < block.end; i += 1) {
    const m = lines[i].match(/^(\s+)-\s*(.*)$/);
    if (!m) break;
    indent = m[1];
    lastIdx = i;
  }
  lines.splice(lastIdx + 1, 0, `${indent ?? '      '}- ${newItemName}`);
}

/** manager を除くサービス名（＝プロジェクトコンテナ）の一覧。 */
function projectServiceNames() {
  const doc = YAML.parse(readText());
  return Object.keys(doc?.services ?? {}).filter((n) => n !== 'manager');
}

/** 読み取り専用のビュー。docker-compose.yml + containers.config.json を突き合わせて返す。 */
export function getComposeView() {
  const text = readText();
  const doc = YAML.parse(text);
  const services = doc?.services ?? {};

  const projects = [];
  for (const [name, svc] of Object.entries(services)) {
    if (name === 'manager') continue;
    const cfg = getContainerConfig(name);
    const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
    const workingDir = svc.working_dir ?? '/workspace';

    let hostWorkspacePath = null;
    let hostVaultPath = null;
    for (const v of volumes) {
      // TARGET は必ず絶対パス（"/..."）なので、それを手がかりに
      // SOURCE:TARGET[:MODE] を分割する。TARGET を "/" 始まりに限定しないと、
      // "…:/vault:ro" のような3分割で "ro" を TARGET と誤認してしまう。
      const m = String(v).match(/^(.+):(\/[^:]+)(:.*)?$/);
      if (!m) continue;
      if (m[2] === workingDir) hostWorkspacePath = m[1];
      if (m[2] === '/vault') hostVaultPath = m[1];
    }

    projects.push({
      name,
      displayName: cfg?.displayName ?? svc.container_name ?? name,
      containerName: svc.container_name ?? name,
      workingDir,
      hostWorkspacePath,
      hostVaultPath,
      // ダッシュボード表示用に ${HOME} を展開した実際のホストパス。
      // hostWorkspacePath / hostVaultPath は編集フォームの元値として変数のまま残す。
      hostWorkspacePathResolved: hostWorkspacePath ? expandHostHome(hostWorkspacePath) : null,
      hostVaultPathResolved: hostVaultPath ? expandHostHome(hostVaultPath) : null,
      permissionMode: cfg?.permissionMode ?? 'bypassPermissions',
      allowedTools: cfg?.allowedTools ?? [],
      model: cfg?.model ?? null,
      role: cfg?.role ?? null,
      registeredInDashboard: Boolean(cfg),
    });
  }

  return {
    projects,
    hostHomeConfigured: Boolean(services.manager?.environment) &&
      JSON.stringify(services.manager.environment).includes('HOST_HOME'),
  };
}

export function validateHostPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 500 &&
    !value.includes('..') && HOST_PATH_RE.test(value);
}

export function validateProjectName(value) {
  return typeof value === 'string' && NAME_RE.test(value);
}

/** 既存プロジェクトの workspace マウント元パスを書き換える。 */
export function updateWorkspaceHostPath(serviceName, newHostPath) {
  if (!validateHostPath(newHostPath)) {
    throw Object.assign(new Error('ホストパスの形式が不正です'), { status: 400 });
  }

  const text = readText();
  const lines = text.split('\n');
  const svcIdx = findServiceLineIndex(lines, serviceName);
  if (svcIdx === -1) {
    throw Object.assign(new Error(`compose にサービスが見つかりません: ${serviceName}`), { status: 404 });
  }
  const block = findBlock(lines, svcIdx);

  const workingDirLine = lines.slice(block.start, block.end).find((l) => /^\s*working_dir:/.test(l));
  const workingDir = workingDirLine?.split(':').slice(1).join(':').trim() || '/workspace';

  const vol = findVolumeLine(lines, block, workingDir);
  if (!vol) {
    throw Object.assign(new Error('workspace のマウント行が見つかりません'), { status: 404 });
  }

  lines[vol.index] = `${vol.prefix}${newHostPath}:${workingDir}${vol.suffix}`;
  writeText(lines.join('\n'));
}

function validateRole(role) {
  return role == null || role === '' || ROLES.includes(role);
}

/** 新しいプロジェクトのサービスを追加し、あわせて containers.config.json にも登録する。 */
export function addProject({ name, displayName, hostPath, permissionMode, allowedTools, model, role }) {
  if (!validateProjectName(name)) {
    throw Object.assign(new Error('プロジェクト名は英小文字・数字・ハイフンのみ、2〜40文字で指定してください'), { status: 400 });
  }
  if (!validateHostPath(hostPath)) {
    throw Object.assign(new Error('ホストパスの形式が不正です'), { status: 400 });
  }
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
    throw Object.assign(new Error('permissionMode が不正です'), { status: 400 });
  }
  if (model && !validateModel(model)) {
    throw Object.assign(new Error('model が不正です'), { status: 400 });
  }
  if (!validateRole(role)) {
    throw Object.assign(new Error('role が不正です'), { status: 400 });
  }

  const text = readText();
  const doc = YAML.parse(text);
  if (doc?.services?.[name]) {
    throw Object.assign(new Error(`このサービス名は既に compose に存在します: ${name}`), { status: 409 });
  }
  if (getContainerConfig(name)) {
    throw Object.assign(new Error(`このコンテナ名は既に登録されています: ${name}`), { status: 409 });
  }

  // 既存プロジェクトから vault / handoff のマウント元を踏襲する
  // （無ければ ${HOME}/Project、${HOME}/Project/.fleet-handoff を既定にする）。
  const existing = Object.entries(doc?.services ?? {}).find(([n]) => n !== 'manager')?.[1];
  const existingVolumes = Array.isArray(existing?.volumes) ? existing.volumes : [];
  const vaultLine = existingVolumes.find((v) => String(v).endsWith(':/vault:ro'));
  const vaultSource = vaultLine ? String(vaultLine).slice(0, -':/vault:ro'.length) : '${HOME}/Project';
  const handoffLine = existingVolumes.find((v) => String(v).endsWith(':/handoff'));
  const handoffSource = handoffLine
    ? String(handoffLine).slice(0, -':/handoff'.length)
    : '${HOME}/Project/.fleet-handoff';

  const lines = text.split('\n');

  const serviceBlock = [
    '',
    `  ${name}:`,
    '    build: .',
    `    container_name: ${name}`,
    '    stdin_open: true',
    '    tty: true',
    '    working_dir: /workspace',
    '    command: ["tail", "-f", "/dev/null"]',
    '    restart: unless-stopped',
    '    volumes:',
    `      - ${name}-config:/home/claude/.claude`,
    `      - ${hostPath}:/workspace`,
    `      - ${vaultSource}:/vault:ro`,
    // パイプライン機能（設計/実装/レビュー/テストの成果物受け渡し）で使う共有フォルダ。
    `      - ${handoffSource}:/handoff`,
  ];

  const topVolumesIdx = lines.findIndex((l) => /^volumes:\s*$/.test(l));
  if (topVolumesIdx === -1) {
    throw Object.assign(new Error('compose の volumes: セクションが見つかりません'), { status: 500 });
  }
  // 直前が既に空行（services: と volumes: の間の区切り）なら、その空行の手前に挿入して
  // 使い回す。そうしないと空行が二重になり、新ブロックの後ろに区切りが無くなる。
  const insertAt = topVolumesIdx > 0 && lines[topVolumesIdx - 1].trim() === ''
    ? topVolumesIdx - 1
    : topVolumesIdx;
  lines.splice(insertAt, 0, ...serviceBlock);

  // 挿入した分だけ後続のインデックスがずれているので、top-level volumes: を再検索する。
  // 既存の名前付きボリューム宣言の末尾（2-indent の兄弟キーが続く限り）に追記する。
  const lines2 = lines;
  const topVolumesIdx2 = lines2.findIndex((l) => /^volumes:\s*$/.test(l));
  let lastVolIdx = topVolumesIdx2;
  for (let i = topVolumesIdx2 + 1; i < lines2.length; i += 1) {
    if (!/^ {2}\S.*:\s*$/.test(lines2[i])) break;
    lastVolIdx = i;
  }
  lines2.splice(lastVolIdx + 1, 0, `  ${name}-config:`);

  // manager の depends_on にも加えておく（無くても動作はするが、起動順の整合性のため）。
  const managerIdx = findServiceLineIndex(lines2, 'manager');
  if (managerIdx !== -1) {
    const managerBlock = findBlock(lines2, managerIdx);
    appendListItem(lines2, managerBlock, /^\s*depends_on:\s*$/, name);
  }

  writeText(lines2.join('\n'));

  // containers.config.json へ登録（manager 再起動なしで一覧に出す＝ここで書いたファイルを
  // config.js が mtime 変化で拾い直す）。
  const configs = JSON.parse(readFileSync(configPath, 'utf8'));
  configs.push({
    name,
    displayName: displayName || name,
    workspacePath: '/workspace',
    permissionMode: permissionMode || 'bypassPermissions',
    ...(Array.isArray(allowedTools) && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(model ? { model } : {}),
    ...(role ? { role } : {}),
  });
  writeFileSync(configPath, `${JSON.stringify(configs, null, 2)}\n`);
}

/** displayName / permissionMode / allowedTools / model / role を containers.config.json 側で更新する。 */
export function updateProjectMeta(name, { displayName, permissionMode, allowedTools, model, role }) {
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
    throw Object.assign(new Error('permissionMode が不正です'), { status: 400 });
  }
  if (model && !validateModel(model)) {
    throw Object.assign(new Error('model が不正です'), { status: 400 });
  }
  if (!validateRole(role)) {
    throw Object.assign(new Error('role が不正です'), { status: 400 });
  }
  const configs = JSON.parse(readFileSync(configPath, 'utf8'));
  const entry = configs.find((c) => c.name === name);
  if (!entry) {
    throw Object.assign(new Error(`未登録のコンテナです: ${name}`), { status: 404 });
  }

  if (displayName !== undefined) entry.displayName = displayName || name;
  if (permissionMode !== undefined) entry.permissionMode = permissionMode;
  if (allowedTools !== undefined) {
    if (Array.isArray(allowedTools) && allowedTools.length > 0) entry.allowedTools = allowedTools;
    else delete entry.allowedTools;
  }
  if (model !== undefined) {
    if (model) entry.model = model;
    else delete entry.model;
  }
  if (role !== undefined) {
    if (role) entry.role = role;
    else delete entry.role;
  }

  writeFileSync(configPath, `${JSON.stringify(configs, null, 2)}\n`);
}

/**
 * 今動いている manager コンテナ自身が属する compose プロジェクト名を、
 * 自分のコンテナラベルから読み取る。
 *
 * `--project-directory` に指定するのは docker-compose.yml をマウントした
 * 先のパス（/compose-project）で、ホスト側の実ディレクトリ名（claude-containers）
 * とは一致しない。プロジェクト名を明示せずに `docker compose` を呼ぶと
 * ディレクトリ名から別名のプロジェクトとして扱われ、既存のコンテナ・
 * ボリューム・イメージを更新せず、同名衝突を起こしながら別セットを
 * 作ろうとしてしまう。それを避けるため、既存コンテナのラベルから
 * 実際のプロジェクト名を取得して `-p` で明示する。
 */
async function currentComposeProjectName() {
  const info = await inspectContainer(os.hostname());
  const name = info?.Config?.Labels?.['com.docker.compose.project'];
  if (!name) {
    const err = new Error('現在の docker compose プロジェクト名を特定できませんでした。');
    err.status = 500;
    throw err;
  }
  return name;
}

/**
 * docker-compose.yml を実際に反映する。manager コンテナ自身に docker CLI と
 * compose プラグインを apk で入れ、docker.sock 経由でホストの docker デーモンを操作する。
 *
 * compose ファイル中の ${HOME} はこのプロセスの環境変数で展開されるが、manager
 * コンテナ自身の HOME はホストの $HOME と一致しないため、docker-compose.yml の
 * manager サービスに設定した HOST_HOME を代わりに使う。
 *
 * `service` を渡すとその1サービスだけを対象にする。省略時は manager を除く
 * 全プロジェクトサービスを対象にする（manager サービス自身は常に除外する。
 * これを含めてしまうと、このリクエストを処理している manager コンテナ自身が
 * 再作成されてリクエスト処理が中断し、壊れた状態のまま取り残されうる）。
 */
export async function applyCompose({ build = false, service = null } = {}) {
  const hostHome = process.env.HOST_HOME;
  if (!hostHome) {
    const err = new Error(
      'HOST_HOME が未設定です。docker-compose.yml の manager サービスを更新後、' +
      '一度だけホスト側で `docker compose up -d --build manager` を実行してください。',
    );
    err.status = 409;
    throw err;
  }

  const targets = service ? [service] : projectServiceNames();
  if (targets.includes('manager')) {
    const err = new Error('manager サービス自身は設定UI からは適用できません。');
    err.status = 400;
    throw err;
  }

  const projectName = await currentComposeProjectName();
  const args = [
    'compose', '-f', COMPOSE_PATH, '--project-directory', PROJECT_ROOT, '-p', projectName, 'up', '-d',
    ...targets,
  ];
  if (build) args.push('--build');

  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOME: hostHome },
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message };
  }
}

export function allProjectNames() {
  return listContainerConfigs().map((c) => c.name);
}
