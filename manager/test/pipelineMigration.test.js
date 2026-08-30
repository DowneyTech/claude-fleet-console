import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 旧バージョン（全チケットを1ファイルにまとめた pipeline.json）からの移行は
// モジュール import 時に一度だけ走る副作用なので、専用のプロセス（= 専用の
// テストファイル。node --test はファイル単位で別プロセスにする）で、
// import する前に旧形式のファイルを用意しておく。
const scratch = mkdtempSync(path.join(os.tmpdir(), 'pipeline-migrate-'));
const projectDir = path.join(scratch, 'project');
const managerDir = path.join(projectDir, 'manager');
mkdirSync(managerDir, { recursive: true });

const legacyTicket = {
  id: '11111111-1111-1111-1111-111111111111',
  title: '移行前チケット',
  stage: 'design',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  autopilot: { consecutiveRejects: 0, totalAutoHops: 0, paused: false },
  sessions: {},
  history: [],
};
// パストラバーサル対策の回帰確認: 不正な id を持つ旧チケットが混ざっていても、
// 移行処理全体が例外で落ちず、そのチケットだけをスキップして続行すること。
const legacyTicketWithBadId = {
  id: '../escape-attempt',
  title: '不正なIDのチケット',
  stage: 'design',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  autopilot: { consecutiveRejects: 0, totalAutoHops: 0, paused: false },
  sessions: {},
  history: [],
};
const legacyPipelineFile = path.join(managerDir, 'pipeline.json');
writeFileSync(legacyPipelineFile, `${JSON.stringify([legacyTicket, legacyTicketWithBadId], null, 2)}\n`);

process.env.COMPOSE_PROJECT_DIR = projectDir;
process.env.CONTAINERS_CONFIG = path.join(scratch, 'containers.config.json');
process.env.HANDOFF_DIR = path.join(scratch, 'handoff');
mkdirSync(process.env.HANDOFF_DIR, { recursive: true });
writeFileSync(process.env.CONTAINERS_CONFIG, JSON.stringify([]));
// PIPELINE_TICKETS_DIR は意図的に設定しない: mountedDir（COMPOSE_PROJECT_DIR/manager）
// が存在するので、tickets/ もその配下に自動で決まるはずであることを確認したい。

const { getTicket, listTickets, ticketsDir } = await import('../src/pipelineStore.js');

test('旧 pipeline.json のチケットが起動時に tickets/ へ移行される', () => {
  assert.equal(ticketsDir, path.join(managerDir, 'tickets'));
  assert.equal(getTicket(legacyTicket.id).title, '移行前チケット');
  assert.equal(listTickets().length, 1);
});

test('移行後、旧 pipeline.json は消え .migrated として残る', () => {
  assert.equal(existsSync(legacyPipelineFile), false);
  assert.equal(existsSync(`${legacyPipelineFile}.migrated`), true);
});

test('移行されたチケットのファイルが tickets/ 配下に実在する', () => {
  assert.equal(existsSync(path.join(ticketsDir, `${legacyTicket.id}.json`)), true);
});

test('不正な id を持つ旧チケットは移行全体を落とさずスキップされる（tickets/ 外に書かれない）', () => {
  assert.equal(listTickets().length, 1); // 正常な1件のみ。不正な1件はスキップされている。
  assert.throws(() => getTicket('../escape-attempt'), (err) => err.status === 400);
  // ticketsDir の外（escape-attempt.json のような場所）に書かれていないこと。
  assert.equal(existsSync(path.join(scratch, 'escape-attempt.json')), false);
  assert.equal(existsSync(path.join(projectDir, 'escape-attempt.json')), false);
});
