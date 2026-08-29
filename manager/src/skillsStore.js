import { execCapture } from './docker.js';

const PERSONAL_ROOT = '/home/claude/.claude/skills';
const PLUGINS_ROOT = '/home/claude/.claude/plugins';

// SKILL.md 本体はプロンプトへそのまま展開する目的の文書なので長いことがある。
// 一覧には frontmatter だけあれば十分なので、各ファイルの先頭だけを読む。
const HEAD_BYTES = 4000;

// 各ファイルの間に入れる区切り。SKILL.md の本文には出てこない前提の文字列。
const SEP = ' SKILL ';

function projectRoot(workspacePath) {
  return `${workspacePath}/.claude/skills`;
}

/** source ごとの検索対象ディレクトリを組み立てる。 */
function roots(workspacePath) {
  return [
    { source: 'project', dir: projectRoot(workspacePath) },
    { source: 'personal', dir: PERSONAL_ROOT },
    { source: 'plugin', dir: PLUGINS_ROOT },
  ];
}

/**
 * frontmatter だけを雑にパースする。SKILL.md の frontmatter は
 * `key: value` の単純な行のみを想定しており、YAML の一般形は扱わない
 * （フル YAML パーサを持ち込むほどの複雑さがこのファイルには無いため）。
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const fields = {};
  let key = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2].trim();
    } else if (key && /^\s+\S/.test(line)) {
      // description が複数行にまたがるケース（折り返し）。素直に連結する。
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** plugins/ 配下のパスから見た目のよいプラグイン名を取り出す。 */
function pluginGroup(dir) {
  // 例: /home/claude/.claude/plugins/marketplaces/<repo>/<plugin>/skills/<name>
  //     /home/claude/.claude/plugins/<plugin>/skills/<name>
  const rel = dir.slice(PLUGINS_ROOT.length + 1).split('/');
  const idx = rel.indexOf('skills');
  if (idx <= 0) return rel[0] ?? 'plugin';
  return rel[idx - 1];
}

/** コンテナ内の SKILL.md を（プロジェクト / 個人 / プラグイン）横断で列挙する。 */
export async function listSkills(name, workspacePath) {
  const dirs = roots(workspacePath).map((r) => r.dir);
  const find = `find ${dirs.map((d) => `'${d}'`).join(' ')} -mindepth 2 -iname SKILL.md 2>/dev/null`;
  const { stdout: pathList } = await execCapture(name, ['sh', '-c', find]);

  const paths = pathList.split('\n').map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) return [];

  // 1回の exec で全ファイルの先頭部分をまとめて取得する（ファイル数ぶん exec すると遅い）。
  const catCmd = paths
    .map((p) => `printf '${SEP}%s\\n' '${p}'; head -c ${HEAD_BYTES} '${p}'`)
    .join('; echo; ');
  const { stdout } = await execCapture(name, ['sh', '-c', catCmd]);

  const chunks = stdout.split(SEP).slice(1);
  const skills = [];
  for (const chunk of chunks) {
    const nl = chunk.indexOf('\n');
    if (nl === -1) continue;
    const filePath = chunk.slice(0, nl).trim();
    const body = chunk.slice(nl + 1);
    const fields = parseFrontmatter(body);

    const dir = filePath.slice(0, filePath.length - '/SKILL.md'.length);
    let source = 'other';
    let group = null;
    if (dir.startsWith(projectRoot(workspacePath) + '/')) {
      source = 'project';
    } else if (dir.startsWith(PERSONAL_ROOT + '/')) {
      source = 'personal';
    } else if (dir.startsWith(PLUGINS_ROOT + '/')) {
      source = 'plugin';
      group = pluginGroup(dir);
    }

    skills.push({
      name: fields.name || dir.split('/').pop(),
      description: fields.description || '',
      source,
      group,
      path: filePath,
    });
  }

  skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return skills;
}
