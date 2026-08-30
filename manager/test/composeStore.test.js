import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// composeStore.js は import 時点の COMPOSE_PROJECT_DIR を見て docker-compose.yml /
// containers.config.json の場所を決めるため、実物を用意してから import する。
const scratch = mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
const managerDir = path.join(scratch, 'manager');
mkdirSync(managerDir, { recursive: true });

const FIXTURE_COMPOSE = `services:
  claude-project-design:
    build: .
    container_name: claude-project-design
    stdin_open: true
    tty: true
    working_dir: /workspace
    command: ["tail", "-f", "/dev/null"]
    restart: unless-stopped
    volumes:
      - claude-project-design-config:/home/claude/.claude
      - \${HOST_PROJECT_DIR}/workspaces/design:/workspace
      - \${HOME}/Project:/vault:ro
      - \${HOME}/Project/.fleet-handoff:/handoff

  manager:
    build: ./manager
    container_name: claude-manager
    environment:
      - HOST_HOME=\${HOME}
    depends_on:
      - claude-project-design

volumes:
  claude-project-design-config:
`;

writeFileSync(path.join(scratch, 'docker-compose.yml'), FIXTURE_COMPOSE);
writeFileSync(
  path.join(managerDir, 'containers.config.json'),
  JSON.stringify(
    [{ name: 'claude-project-design', displayName: '設計', workspacePath: '/workspace', permissionMode: 'acceptEdits' }],
    null,
    2,
  ),
);

process.env.COMPOSE_PROJECT_DIR = scratch;

const { addProject, getComposeView, updateWorkspaceHostPath, validateHostPath, validateModel, validateProjectName } =
  await import('../src/composeStore.js');

test('validateHostPath: 絶対パスと ${VAR} 形式は許可する', () => {
  assert.equal(validateHostPath('/Users/someone/Project'), true);
  assert.equal(validateHostPath('${HOME}/Project'), true);
});

test('validateHostPath: 相対パス・".." を含むパスは拒否する', () => {
  assert.equal(validateHostPath('relative/path'), false);
  assert.equal(validateHostPath('/Users/someone/../etc'), false);
  assert.equal(validateHostPath(''), false);
});

test('validateProjectName: 英小文字・数字・ハイフンのみ許可する', () => {
  assert.equal(validateProjectName('claude-project-x'), true);
  assert.equal(validateProjectName('Claude-Project'), false); // 大文字不可
  assert.equal(validateProjectName('a'), false); // 短すぎる
  assert.equal(validateProjectName('1abc'), false); // 数字始まり不可
});

test('validateModel: 既知のプリセット以外でも記号のみ弾く', () => {
  assert.equal(validateModel('opus'), true);
  assert.equal(validateModel('claude-opus-5'), true);
  assert.equal(validateModel(''), false);
  assert.equal(validateModel('opus; rm -rf /'), false);
});

test('addProject: サービスを追加でき、getComposeView に反映される', () => {
  addProject({
    name: 'claude-project-review',
    displayName: 'レビュー',
    hostPath: '/Users/someone/Project/claude-containers/workspaces/review',
    permissionMode: 'plan',
    allowedTools: ['Read', 'Grep', 'Glob'],
    role: 'review',
  });

  const view = getComposeView();
  const added = view.projects.find((p) => p.name === 'claude-project-review');
  assert.ok(added, '追加したサービスが getComposeView に現れること');
  assert.equal(added.displayName, 'レビュー');
  assert.equal(added.permissionMode, 'plan');
  assert.deepEqual(added.allowedTools, ['Read', 'Grep', 'Glob']);
  assert.equal(added.role, 'review');
  assert.equal(added.registeredInDashboard, true);

  // 既存サービス（claude-project-design）の vault/handoff マウント元を踏襲していること。
  assert.equal(added.hostVaultPath, '${HOME}/Project');

  // docker-compose.yml が引き続き妥当な YAML であること（壊れていれば addProject 内の
  // writeTextValidated が既に例外を投げているはずだが、念のため実ファイルでも確認する）。
  const text = readFileSync(path.join(scratch, 'docker-compose.yml'), 'utf8');
  assert.match(text, /claude-project-review:/);
  assert.match(text, /claude-project-review-config:/);
});

test('addProject: 既存と同じサービス名は409相当のエラーになる', () => {
  assert.throws(() => addProject({ name: 'claude-project-design', hostPath: '/tmp/x' }), (err) => err.status === 409);
});

test('addProject: 不正なホストパスは400相当のエラーになる', () => {
  assert.throws(
    () => addProject({ name: 'claude-project-bad', hostPath: '../not-absolute' }),
    (err) => err.status === 400,
  );
});

test('updateWorkspaceHostPath: workspace マウント行を書き換えられる', () => {
  updateWorkspaceHostPath('claude-project-design', '/Users/someone/moved/workspaces/design');
  const view = getComposeView();
  const design = view.projects.find((p) => p.name === 'claude-project-design');
  assert.equal(design.hostWorkspacePath, '/Users/someone/moved/workspaces/design');

  // 他の行（vault/handoff）は書き換わっていないこと。
  assert.equal(design.hostVaultPath, '${HOME}/Project');
});

test('updateWorkspaceHostPath: 存在しないサービス名は404相当のエラーになる', () => {
  assert.throws(
    () => updateWorkspaceHostPath('claude-project-does-not-exist', '/tmp/x'),
    (err) => err.status === 404,
  );
});
