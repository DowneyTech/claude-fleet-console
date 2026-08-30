import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// pipelineStore.js は import 時点の環境変数からチケット保存先・コンテナ設定・
// handoff ディレクトリの場所を決めるため、実物を用意してから import する。
const scratch = mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
process.env.PIPELINE_TICKETS_DIR = path.join(scratch, 'tickets');
process.env.CONTAINERS_CONFIG = path.join(scratch, 'containers.config.json');
process.env.HANDOFF_DIR = path.join(scratch, 'handoff');
mkdirSync(process.env.HANDOFF_DIR, { recursive: true });
writeFileSync(
  process.env.CONTAINERS_CONFIG,
  JSON.stringify([
    { name: 'claude-project-design', role: 'design' },
    { name: 'claude-project-implement', role: 'implement', requiresApproval: true },
  ]),
);

const {
  createTicket,
  getTicket,
  listTickets,
  removeTicket,
  checkAutopilotBudget,
  needsHumanApproval,
  extractQuotes,
  reasonCitesArtifact,
  buildHandoffPrompt,
} = await import('../src/pipelineStore.js');

test('createTicket は design ステージで作られ、listTickets/getTicket から見える', async () => {
  const ticket = await createTicket({ title: 'チケットA' });
  assert.equal(ticket.stage, 'design');
  assert.equal(getTicket(ticket.id).title, 'チケットA');
  assert.ok(listTickets().some((t) => t.id === ticket.id));
  await removeTicket(ticket.id);
});

test('createTicket は空白のみの title を拒否する', () => {
  // バリデーションエラーは withTicketLock に入る前の同期チェックで、
  // 同期的に throw する（Promise の reject ではない）。
  assert.throws(() => createTicket({ title: '   ' }), (err) => err.status === 400);
});

test('getTicket は未登録IDで404相当のエラーを投げる', () => {
  assert.throws(() => getTicket('00000000-0000-0000-0000-000000000000'), (err) => err.status === 404);
});

test('セキュリティ回帰: id にパストラバーサルを仕込んでも tickets/ の外を読めない（400）', () => {
  // tickets/ の外側（scratch 直下）に機密ファイルを模したファイルを置く。
  // ticketFilePath の検証が無いと path.join(ticketsDir, `${id}.json`) が
  // これを指してしまう（containers.config.json 等が実例）。
  const outsideFile = path.join(scratch, 'containers.config');
  writeFileSync(outsideFile, JSON.stringify({ secret: 'must-not-leak' }));

  assert.throws(
    () => getTicket('../containers.config'),
    (err) => err.status === 400,
  );
});

test('セキュリティ回帰: id にパストラバーサルを仕込んでも removeTicket は外のファイルを消せない（400）', async () => {
  const outsideFile = path.join(scratch, 'do-not-delete.json');
  writeFileSync(outsideFile, JSON.stringify({ keep: true }));

  await assert.rejects(() => removeTicket('../do-not-delete'), (err) => err.status === 400);

  const { existsSync, readFileSync } = await import('node:fs');
  assert.equal(existsSync(outsideFile), true);
  assert.deepEqual(JSON.parse(readFileSync(outsideFile, 'utf8')), { keep: true });
});

test('listTickets は作成順（createdAt 昇順）で返す', async () => {
  const first = await createTicket({ title: '先に作った方' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await createTicket({ title: '後に作った方' });

  const ids = listTickets().map((t) => t.id);
  assert.ok(ids.indexOf(first.id) < ids.indexOf(second.id));

  await removeTicket(first.id);
  await removeTicket(second.id);
});

test('removeTicket 後は listTickets/getTicket から消える', async () => {
  const ticket = await createTicket({ title: 'チケットB' });
  await removeTicket(ticket.id);
  assert.throws(() => getTicket(ticket.id));
  assert.ok(!listTickets().some((t) => t.id === ticket.id));
});

test('checkAutopilotBudget: 累計ホップ上限（既定12）を超えると一時停止する', () => {
  const ticket = { autopilot: { consecutiveRejects: 0, totalAutoHops: 12 } };
  const result = checkAutopilotBudget(ticket, { isReject: false });
  assert.equal(result.ok, false);
  assert.equal(result.autopilot.paused, true);
});

test('checkAutopilotBudget: 連続REJECT上限（既定3）を超えると一時停止する', () => {
  const ticket = { autopilot: { consecutiveRejects: 3, totalAutoHops: 0 } };
  const result = checkAutopilotBudget(ticket, { isReject: true });
  assert.equal(result.ok, false);
  assert.equal(result.autopilot.paused, true);
});

test('checkAutopilotBudget: 上限内なら許可され、カウンタが1つ進む', () => {
  const ticket = { autopilot: { consecutiveRejects: 0, totalAutoHops: 0 } };
  const result = checkAutopilotBudget(ticket, { isReject: false });
  assert.equal(result.ok, true);
  assert.equal(result.autopilot.totalAutoHops, 1);
  assert.equal(result.autopilot.consecutiveRejects, 0);
});

test('checkAutopilotBudget: ADVANCE を挟むと連続REJECTカウントがリセットされる', () => {
  const ticket = { autopilot: { consecutiveRejects: 2, totalAutoHops: 5 } };
  const result = checkAutopilotBudget(ticket, { isReject: false });
  assert.equal(result.autopilot.consecutiveRejects, 0);
});

test('needsHumanApproval: actor が human なら常にスルーする', () => {
  assert.equal(needsHumanApproval('human', 'implement'), null);
});

test('needsHumanApproval: master actor が requiresApproval な工程へ向かうと止める', () => {
  const gate = needsHumanApproval('master', 'implement');
  assert.ok(gate);
  assert.equal(gate.name, 'claude-project-implement');
});

test('needsHumanApproval: master actor でも requiresApproval が無い工程はスルーする', () => {
  assert.equal(needsHumanApproval('master', 'design'), null);
});

test('needsHumanApproval: done 行きは常にスルーする', () => {
  assert.equal(needsHumanApproval('master', 'done'), null);
});

test('extractQuotes: 「」/""/\'\' の引用をすべて拾う', () => {
  assert.deepEqual(extractQuotes('前置き「和文引用」あと "english quote" と \'single quote\''), [
    '和文引用',
    'english quote',
    'single quote',
  ]);
});

test('extractQuotes: 引用が無ければ空配列', () => {
  assert.deepEqual(extractQuotes('引用なしの文章です'), []);
});

test('reasonCitesArtifact: 引用が成果物に実在すれば true（空白差は無視）', () => {
  assert.equal(reasonCitesArtifact('「重要な 指摘」があった', '# review\n重要な\n指摘\nOK'), true);
});

test('reasonCitesArtifact: 成果物に無い引用（捏造引用）は false', () => {
  assert.equal(reasonCitesArtifact('「存在しない一節」', '# review\n別の内容'), false);
});

test('reasonCitesArtifact: 引用マーカーが無ければ false', () => {
  assert.equal(reasonCitesArtifact('引用なしの理由です', '本文には色々書いてある'), false);
});

test('buildHandoffPrompt: 工程ラベル・成果物パス・引き継ぎメモ・注意書きを含む', () => {
  const prompt = buildHandoffPrompt({ id: 'abc-123', title: 'タイトル' }, 'implement', 'ここに注意');
  assert.match(prompt, /実装工程/);
  assert.match(prompt, /\/handoff\/abc-123\//);
  assert.match(prompt, /ここに注意/);
  assert.match(prompt, /参考情報として扱ってください/);
});

test('buildHandoffPrompt: design（先頭工程）には直前工程の成果物参照が無い', () => {
  const prompt = buildHandoffPrompt({ id: 'abc-123', title: 'タイトル' }, 'design', null);
  assert.doesNotMatch(prompt, /直前の.+工程の成果物/);
});
