import { execCapture, writeFile } from './docker.js';

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

// 設計・実装・レビュー・テストという役割分業を始めるときに、各プロジェクトへ
// そのまま登録できる叩き台。精度を役割特化させる効果が一番大きいのはここの
// 中身（何を確認し、何をしないか）なので、必要に応じて保存前に書き換える前提。
export const ROLE_SKILL_TEMPLATES = {
  design: {
    slug: 'design-review',
    title: '設計レビュー観点',
    content: `---
name: design-review
description: 設計を行う際に必ず確認する観点
---

# 設計工程のガイド

- 要件・制約・非機能要件（性能/セキュリティ/運用）を明文化してから設計に入る
- 既存アーキテクチャ・命名規則との整合性を確認する
- 影響範囲・後方互換性・拡張性を検討する
- 決定事項と、検討した代替案・トレードオフを記録として残す
- 実装担当が迷わない粒度までインターフェース（API・データ構造）を具体化する
- 自分でコードを実装しない。成果物は設計文書としてまとめる
`,
  },
  implement: {
    slug: 'implementation-guidelines',
    title: '実装規約',
    content: `---
name: implementation-guidelines
description: 実装時に守るコーディング規約
---

# 実装工程のガイド

- 設計ドキュメントの意図から外れる場合は、その理由をコメントか引き継ぎメモに残す
- 既存の命名規則・ディレクトリ構成・コードスタイルに合わせる
- レビューしやすい単位・粒度に変更を分割する
- 不要な変更（無関係な整形・リファクタ）を混ぜない
- 完了時は \`git diff\` の内容を自分で確認してから引き渡す
`,
  },
  review: {
    slug: 'code-review-checklist',
    title: 'コードレビューチェックリスト',
    content: `---
name: code-review-checklist
description: コードレビュー時のチェックリスト
---

# レビュー工程のガイド

- 設計意図と実装が一致しているか
- エッジケース・エラー処理・例外系が漏れていないか
- 命名・可読性・重複コードの有無
- セキュリティ上のリスク（インジェクション・権限・秘匿情報の扱いなど）
- テストが変更内容に対して十分か
- コードは直接編集せず、指摘事項として記録する（自分では直さない）
`,
  },
  test: {
    slug: 'test-plan-checklist',
    title: 'テスト観点',
    content: `---
name: test-plan-checklist
description: テスト実施時に確認する観点
---

# テスト工程のガイド

- 正常系・異常系・境界値を網羅する
- 既存のテストスイートを壊していないか（回帰確認）
- 再現手順・実行コマンド・結果を明確に記録する
- 失敗した場合は原因の切り分け（どこまで動いてどこから壊れるか）まで行う
`,
  },
};

/** プロジェクト固有の SKILL.md を書き込む（無ければ作成、あれば上書き）。 */
export async function writeSkill(name, workspacePath, slug, content) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) {
    throw Object.assign(new Error('slug は英小文字・数字・ハイフンのみで指定してください'), { status: 400 });
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('content が必要です'), { status: 400 });
  }
  const filePath = `${projectRoot(workspacePath)}/${slug}/SKILL.md`;
  await writeFile(name, filePath, content);
  return { path: filePath };
}
