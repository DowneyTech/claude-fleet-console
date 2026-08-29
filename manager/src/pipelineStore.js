import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listContainerConfigs } from './config.js';
import { ensureTicketDir } from './handoffStore.js';
import { startTask } from './taskRunner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// templateStore.js と同じ考え方: プロジェクトルートが読み書きマウントされて
// いれば（`.:/compose-project`）そちらへ保存し、manager コンテナの再作成後も
// チケットが残るようにする。無ければイメージ同梱のパスへフォールバックする。
const mountedDir = path.join(process.env.COMPOSE_PROJECT_DIR ?? '/compose-project', 'manager');

export const pipelinePath = process.env.PIPELINE_FILE
  ? path.resolve(process.env.PIPELINE_FILE)
  : existsSync(mountedDir)
    ? path.join(mountedDir, 'pipeline.json')
    : path.join(appRoot, 'pipeline.json');

// 設計 → 実装 → レビュー → テスト → 完了、の固定フロー。
// containers.config.json の role がこの stage 名と一致するプロジェクトへタスクを送る。
export const STAGE_ORDER = ['design', 'implement', 'review', 'test', 'done'];

export const STAGE_META = {
  design: {
    label: '設計',
    artifact: 'design.md',
    instruction: '設計内容（要件・方針・懸念点）をまとめてください。',
  },
  implement: {
    label: '実装',
    artifact: 'implement.md',
    instruction:
      '実装内容の要約を書いてください。可能であれば `git diff` の出力を patch.diff として書き出してください。',
  },
  review: {
    label: 'レビュー',
    artifact: 'review.md',
    instruction: 'コードは直接編集せず、指摘事項と可否（LGTM か要修正か）をまとめてください。',
  },
  test: {
    label: 'テスト',
    artifact: 'test.md',
    instruction: 'テストを実行し、結果と（失敗した場合は）再現手順をまとめてください。',
  },
  done: { label: '完了', artifact: null, instruction: null },
};

function load() {
  if (!existsSync(pipelinePath)) return [];
  try {
    const data = JSON.parse(readFileSync(pipelinePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    // 書き込み途中などで壊れた状態を一瞬読んでしまった場合は空として扱う。
    return [];
  }
}

function save(list) {
  writeFileSync(pipelinePath, `${JSON.stringify(list, null, 2)}\n`);
}

/** その工程を担当するプロジェクト（containers.config.json の role が一致するもの）。 */
function projectForStage(stage) {
  return listContainerConfigs().find((c) => c.role === stage) ?? null;
}

export function stagesInfo() {
  return STAGE_ORDER.map((stage) => {
    const project = projectForStage(stage);
    return {
      stage,
      label: STAGE_META[stage].label,
      project: project?.name ?? null,
      displayName: project?.displayName ?? null,
    };
  });
}

export function listTickets() {
  return load();
}

export function getTicket(id) {
  const ticket = load().find((t) => t.id === id);
  if (!ticket) {
    throw Object.assign(new Error(`未登録のチケットです: ${id}`), { status: 404 });
  }
  return ticket;
}

export function createTicket({ title }) {
  if (typeof title !== 'string' || !title.trim()) {
    throw Object.assign(new Error('title が必要です'), { status: 400 });
  }
  const id = randomUUID();
  ensureTicketDir(id);

  const ticket = {
    id,
    title: title.trim(),
    stage: STAGE_ORDER[0],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [{ stage: STAGE_ORDER[0], at: Date.now(), kind: 'created', note: null, project: null }],
  };

  const list = load();
  list.push(ticket);
  save(list);
  return ticket;
}

export function removeTicket(id) {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) {
    throw Object.assign(new Error(`未登録のチケットです: ${id}`), { status: 404 });
  }
  save(next);
}

/**
 * 直前工程の成果物への参照とメモを含めた、送信先工程向けの指示文を組み立てる。
 * 工程ごとに何を確認し何を書き出すべきかは STAGE_META に集約しているので、
 * ここでは前後の工程を繋ぐだけでよい。
 */
function buildHandoffPrompt(ticket, stage, note) {
  const dir = `/handoff/${ticket.id}`;
  const meta = STAGE_META[stage];
  const idx = STAGE_ORDER.indexOf(stage);
  const prevStage = idx > 0 ? STAGE_ORDER[idx - 1] : null;
  const prevMeta = prevStage ? STAGE_META[prevStage] : null;

  const lines = [
    `パイプライン案件「${ticket.title}」（id: ${ticket.id}）の${meta.label}工程です。`,
    `関連ファイルは ${dir}/ にあります。まず \`ls ${dir}\` で何があるか確認してください。`,
  ];
  if (prevMeta?.artifact) {
    lines.push(`直前の${prevMeta.label}工程の成果物: ${dir}/${prevMeta.artifact}`);
  }
  if (note) {
    lines.push(`引き継ぎメモ: ${note}`);
  }
  if (meta.instruction) {
    lines.push(`${meta.instruction}\n完了したら、その内容を ${dir}/${meta.artifact} に書き出してください。`);
  }
  return lines.join('\n');
}

async function sendToStage(ticket, stage, note) {
  const cfg = projectForStage(stage);
  if (!cfg) {
    throw Object.assign(
      new Error(
        `「${STAGE_META[stage]?.label ?? stage}」を担当するプロジェクトが設定されていません。` +
          'コンテナ設定で role を指定してください。',
      ),
      { status: 409 },
    );
  }
  ensureTicketDir(ticket.id);
  const prompt = buildHandoffPrompt(ticket, stage, note);
  const result = await startTask(cfg, { prompt, newSession: false, model: null, enqueueIfBusy: true });
  return {
    project: cfg.name,
    displayName: cfg.displayName,
    queued: Boolean(result.queued),
    taskId: result.queued ? result.item.id : result.id,
  };
}

/** 現在の工程の担当プロジェクトへ（再）送信する。ステージは変えない。 */
export async function sendCurrentStage(id, note) {
  const list = load();
  const ticket = list.find((t) => t.id === id);
  if (!ticket) throw Object.assign(new Error(`未登録のチケットです: ${id}`), { status: 404 });

  const outcome = await sendToStage(ticket, ticket.stage, note);
  ticket.updatedAt = Date.now();
  ticket.history.push({ stage: ticket.stage, at: Date.now(), kind: 'sent', note: note || null, project: outcome.project });
  save(list);
  return { ticket, outcome };
}

/** 次の工程へ進め、その工程の担当プロジェクトへ自動でタスクを送信する。 */
export async function advanceTicket(id, note) {
  const list = load();
  const ticket = list.find((t) => t.id === id);
  if (!ticket) throw Object.assign(new Error(`未登録のチケットです: ${id}`), { status: 404 });

  const idx = STAGE_ORDER.indexOf(ticket.stage);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) {
    throw Object.assign(new Error('これ以上先の工程はありません'), { status: 409 });
  }
  const nextStage = STAGE_ORDER[idx + 1];

  const outcome = nextStage === 'done' ? null : await sendToStage(ticket, nextStage, note);
  ticket.stage = nextStage;
  ticket.updatedAt = Date.now();
  ticket.history.push({
    stage: nextStage,
    at: Date.now(),
    kind: 'advanced',
    note: note || null,
    project: outcome?.project ?? null,
  });
  save(list);
  return { ticket, outcome };
}

/** 手前の工程へ差し戻す（例: レビューで指摘 → 実装へ戻す）。 */
export async function rejectTicket(id, toStage, note) {
  if (!STAGE_ORDER.includes(toStage) || toStage === 'done') {
    throw Object.assign(new Error('差し戻し先の工程が不正です'), { status: 400 });
  }
  const list = load();
  const ticket = list.find((t) => t.id === id);
  if (!ticket) throw Object.assign(new Error(`未登録のチケットです: ${id}`), { status: 404 });

  const outcome = await sendToStage(ticket, toStage, note);
  ticket.stage = toStage;
  ticket.updatedAt = Date.now();
  ticket.history.push({ stage: toStage, at: Date.now(), kind: 'rejected', note: note || null, project: outcome.project });
  save(list);
  return { ticket, outcome };
}
