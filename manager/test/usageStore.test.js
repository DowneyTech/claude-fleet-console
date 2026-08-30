import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// usageStore.js は import 時点の USAGE_FILE を見て永続化先を決めるため、
// 先に環境変数を設定してから import する。
const scratch = mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
process.env.USAGE_FILE = path.join(scratch, 'usage.json');

const { extractUsage, recordResult, recordTicketUsage, resetUsage, usageFor, usageForTicket, fleetUsage, usagePath } =
  await import('../src/usageStore.js');

function fakeResult(overrides = {}) {
  return {
    total_cost_usd: 0.05,
    num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    ...overrides,
  };
}

test('extractUsage: result イベントから costUsd/トークンを取り出す', () => {
  const usage = extractUsage(fakeResult());
  assert.equal(usage.costUsd, 0.05);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.turns, 2);
});

test('recordResult: 同じコンテナへの複数回の記録が積み上がる', () => {
  recordResult('claude-project-design', fakeResult());
  recordResult('claude-project-design', fakeResult({ total_cost_usd: 0.03 }));
  const total = usageFor('claude-project-design');
  assert.equal(total.tasks, 2);
  assert.ok(Math.abs(total.costUsd - 0.08) < 1e-9);
});

test('recordResult: usage.json へ永続化される', () => {
  assert.equal(existsSync(usagePath), true);
  const persisted = JSON.parse(readFileSync(usagePath, 'utf8'));
  assert.ok(persisted.totals['claude-project-design']);
  assert.equal(persisted.totals['claude-project-design'].tasks, 2);
});

test('recordTicketUsage: チケット単位でも累計する', () => {
  recordTicketUsage('ticket-1', extractUsage(fakeResult()));
  recordTicketUsage('ticket-1', extractUsage(fakeResult({ total_cost_usd: 0.02 })));
  const total = usageForTicket('ticket-1');
  assert.equal(total.tasks, 2);
  assert.ok(Math.abs(total.costUsd - 0.07) < 1e-9);
});

test('fleetUsage: 全コンテナの合計を返す', () => {
  recordResult('claude-project-implement', fakeResult({ total_cost_usd: 0.1 }));
  const sum = fleetUsage();
  assert.ok(sum.costUsd > 0.1); // design 分 + implement 分
  assert.ok(sum.tasks >= 3);
});

test('resetUsage: 単一コンテナだけ消える（他は残る）', () => {
  resetUsage('claude-project-design');
  assert.equal(usageFor('claude-project-design').tasks, 0);
  assert.ok(usageFor('claude-project-implement').tasks > 0);
});

test('resetUsage: 引数なしで全コンテナ消える', () => {
  resetUsage();
  assert.equal(usageFor('claude-project-implement').tasks, 0);
  assert.equal(fleetUsage().tasks, 0);
});
