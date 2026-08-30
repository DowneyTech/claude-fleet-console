'use strict';

import { markdownBlock } from './markdown.js';

const POLL_MS = 5000;

const grid = document.getElementById('grid');
const template = document.getElementById('card-template');
const summaryEl = document.getElementById('summary');
const pollEl = document.getElementById('poll-state');
const bannerEl = document.getElementById('banner');
const emptyEl = document.getElementById('empty');
const masterPanel = document.getElementById('master-panel');
const masterPanelEmpty = document.getElementById('master-panel-empty');

const cards = new Map();   // name -> { root, els }
const streams = new Map(); // name -> EventSource

const ACTIVITY_LABEL = {
  working: '実行中',
  recent: '直近に活動',
  idle: 'アイドル',
  stopped: '停止中',
  missing: '未作成',
};

const STATE_LABEL = {
  running: '起動中',
  exited: '終了',
  created: '作成済み',
  paused: '一時停止',
  restarting: '再起動中',
  missing: 'コンテナ未作成',
};

const ROLE_LABEL = {
  design: '設計',
  implement: '実装',
  review: 'レビュー',
  test: 'テスト',
  master: 'マスター',
};

// プロジェクトごとの「顔」。名前から決定的に選ぶので、再読み込みしても同じ担当が
// 同じキャラのままになる（見た目でどのカードか覚えやすくするため）。
const CHARACTERS = ['🐱', '🐶', '🦊', '🐼', '🐰', '🐻', '🐯', '🦁', '🐸', '🐵', '🦉', '🐧'];

function characterFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CHARACTERS[Math.abs(hash) % CHARACTERS.length];
}

/* ------------------------------ helpers ------------------------------ */

// manager が任意で有効化できる共有トークン認証（FLEET_CONSOLE_TOKEN）用。
// 未設定（既定）のときはこのヘッダは付くが manager 側で無視されるだけなので、
// 通常運用には影響しない。
const TOKEN_STORAGE_KEY = 'fleetConsoleToken';

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return ''; // localStorage が使えない環境（プライベートブラウズ等）でも致命的にしない。
  }
}

function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 保存できなくても、このリクエスト自体は続行できる。
  }
}

// EventSource 用。カスタムヘッダを付けられないため、トークンをクエリ文字列で渡す。
function tokenQueryParam() {
  const token = getStoredToken();
  return token ? `?token=${encodeURIComponent(token)}` : '';
}

// manager 側の CSRF 対策（単純な <form> POST では付けられないヘッダを必須化）に
// 合わせて、すべてのリクエストにこのヘッダを付ける。値そのものに意味はない
// （秘密情報ではない）が、cross-origin の fetch は非単純リクエスト扱いになり
// CORS プリフライトでブロックされる、というのが実際の防御になる。
async function apiCall(base, path, options = {}, retried = false) {
  const token = getStoredToken();
  const headers = {
    ...(options.headers ?? {}),
    'X-Fleet-Console': '1',
    ...(token ? { 'X-Fleet-Token': token } : {}),
  };
  const res = await fetch(`${base}${path}`, { ...options, headers });

  // FLEET_CONSOLE_TOKEN が設定されている manager からのみ返る。未設定なら発生しない。
  if (res.status === 401 && !retried) {
    const input = window.prompt('manager がアクセストークンを要求しています（FLEET_CONSOLE_TOKEN）。入力してください:');
    if (input) {
      setStoredToken(input);
      return apiCall(base, path, options, true);
    }
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

const api = (path, options) => apiCall('/api/containers', path, options);
const apiConfig = (path, options) => apiCall('/api/config', path, options);
const apiPipeline = (path, options) => apiCall('/api/pipeline', path, options);
const apiSkillTemplates = (path, options) => apiCall('/api/skill-templates', path, options);

function ago(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}

function duration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function short(id) {
  return id ? id.slice(0, 8) : '—';
}

/**
 * 省略表示されているパス欄をクリックで全文表示（折り返し）に切り替え、
 * 同時にフルパスをクリップボードへコピーする。値が無い（'—'）ときは何もしない。
 */
function setupCopyablePath(dd) {
  const hint = dd.nextElementSibling;

  const activate = async () => {
    const text = dd.dataset.fullText;
    if (!text) return;
    dd.classList.toggle('expanded');
    try {
      await navigator.clipboard.writeText(text);
      if (hint) {
        hint.classList.add('show');
        clearTimeout(hint._copyTimer);
        hint._copyTimer = setTimeout(() => hint.classList.remove('show'), 1400);
      }
    } catch {
      // クリップボード API が使えない場合（権限拒否など）は全文表示の切り替えのみ行う。
    }
  };

  dd.addEventListener('click', activate);
  dd.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
}

/** パス欄にフルテキストを設定する。'—' 表示のときはコピー対象なしとして扱う。 */
function setPathText(dd, path) {
  dd.textContent = path || '—';
  dd.title = path ? `${path}（クリックでコピー）` : '';
  dd.dataset.fullText = path || '';
}

function formatBytes(bytes) {
  if (!bytes) return '0MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/* ------------------------- gauges (context / limits) ------------------------- */

const LIMIT_LABEL = {
  five_hour: '5時間の上限',
  seven_day: '週の上限',
  seven_day_opus: '週の上限（Opus）',
  seven_day_oauth_apps: '週の上限（連携アプリ）',
};

// 表示順。ここに無い種類も後ろにまとめて出す（CLI 側の追加を落とさないため）。
const LIMIT_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_oauth_apps'];

const limitLabel = (type) => LIMIT_LABEL[type] ?? type;

function level(ratio) {
  if (ratio >= 0.9) return 'high';
  if (ratio >= 0.7) return 'mid';
  return '';
}

/** リセットまでの残り。絶対時刻より「あとどれくらい」の方が判断に使える。 */
function until(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  if (diff <= 0) return 'まもなくリセット';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `あと ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `あと ${hours} 時間 ${rest} 分` : `あと ${hours} 時間`;
  return `あと ${Math.floor(hours / 24)} 日 ${hours % 24} 時間`;
}

function gauge({ label, ratio, value, note, title }) {
  const wrap = el('div', 'gauge');
  if (title) wrap.title = title;

  const head = el('div', 'gauge-head');
  head.append(el('span', 'gauge-label', label), el('span', 'gauge-value', value));

  const bar = el('div', 'gauge-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${label} ${value}`);
  const fill = document.createElement('i');
  // ratio が null は「値なし」。インラインで幅を書くとクラス側の 0 指定に
  // 勝ってしまうので、値がないときは何も書かない。
  if (ratio != null) {
    // 0% でも棒の存在が分かるよう最低幅を持たせる。
    fill.style.width = `${Math.max(1.5, Math.min(1, ratio) * 100).toFixed(1)}%`;
    const lv = level(ratio);
    if (lv) fill.dataset.level = lv;
  }
  bar.appendChild(fill);

  wrap.append(head, bar);
  if (note) wrap.appendChild(el('div', 'gauge-note', note));
  return wrap;
}

/**
 * Anthropic のアカウント使用状況 API から取った利用率。ログインしていれば
 * 常に数値が入っている（CLI ログ頼みだった旧実装と違い「上限に近づくまで
 * 値が来ない」ということが無い）。
 */
function limitGauge(type, limit) {
  const ratio = limit.utilization;

  const notes = [until(limit.resetsAt)];
  if (limit.isUsingOverage) notes.push('追加利用中');
  if (limit.status) notes.push(limit.status);

  return gauge({
    label: limitLabel(type),
    ratio,
    value: `${Math.round(ratio * 100)}%`,
    note: notes.filter(Boolean).join(' · '),
    title: limit.resetsAt ? `${new Date(limit.resetsAt).toLocaleString('ja-JP')} にリセット` : '',
  });
}

const UNAVAILABLE_HINT = 'ログインしていないか、まだ取得できていません（30秒ごとに再取得します）。';

/** rateLimits を表示順に並べる。未知の種類も末尾に残す。 */
function orderedLimits(rateLimits) {
  const entries = Object.entries(rateLimits ?? {}).filter(([, l]) => l && typeof l === 'object');
  return entries.sort(([a], [b]) => {
    const ia = LIMIT_ORDER.indexOf(a);
    const ib = LIMIT_ORDER.indexOf(b);
    return (ia === -1 ? LIMIT_ORDER.length : ia) - (ib === -1 ? LIMIT_ORDER.length : ib);
  });
}

/** まだ取得できていない窓を表す、値なしのゲージ。 */
function placeholderGauge(type) {
  const wrap = el('div', 'gauge is-unknown');
  wrap.title = UNAVAILABLE_HINT;

  const head = el('div', 'gauge-head');
  head.append(el('span', 'gauge-label', limitLabel(type)), el('span', 'gauge-value', '未取得'));

  const bar = el('div', 'gauge-bar');
  bar.appendChild(document.createElement('i'));

  wrap.append(head, bar, el('div', 'gauge-note', 'ログイン状態を確認してください'));
  return wrap;
}

/**
 * カード上部の常時表示ゲージ。レート上限（5時間 / 週）だけを出す。
 * トークン使用量はヘッダーに一本化したので、ここには出さない。
 * 残り時間が刻々と変わるので毎回組み直す（中身は数ノードなので
 * 作り直しの方が差分更新より単純で安全）。
 */
function renderGauges(card, data) {
  const box = card.els.gauges;
  box.textContent = '';

  const limits = orderedLimits(data.rateLimits);
  for (const [type, limit] of limits) {
    box.appendChild(limitGauge(type, limit));
  }

  // ログインしているのにまだ最初のポーリングが済んでいないだけの場合に、
  // 空の枠だけでも出しておく（コンテナが未ログイン/未起動なら何も出さない）。
  const seen = new Set(limits.map(([type]) => type));
  if (data.auth?.loggedIn) {
    for (const type of LIMIT_ORDER.slice(0, 2)) {
      if (!seen.has(type)) box.appendChild(placeholderGauge(type));
    }
  }

  box.hidden = box.childElementCount === 0;
}

/** 実行ログの 1 行。body は文字列でも Node でもよい。 */
function row(tag, body, className) {
  const el = document.createElement('div');
  el.className = className ? `ev ${className}` : 'ev';

  const tagEl = document.createElement('span');
  tagEl.className = 'ev-tag';
  tagEl.textContent = tag;

  const bodyEl = document.createElement('span');
  bodyEl.className = 'ev-body';
  if (body instanceof Node) bodyEl.appendChild(body);
  else bodyEl.textContent = body ?? '';

  el.append(tagEl, bodyEl);
  return el;
}

function preview(value, limit = 300) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/* --------------------------- stream rendering --------------------------- */

/** stream-json の 1 オブジェクトを 0 行以上の DOM に変換する。 */
function renderStreamJson(obj) {
  const frag = document.createDocumentFragment();

  if (obj.type === 'system') {
    const bits = [obj.subtype ?? 'system'];
    if (obj.model) bits.push(obj.model);
    if (obj.cwd) bits.push(obj.cwd);
    frag.appendChild(row('system', bits.join(' · '), 'note'));
    return frag;
  }

  if (obj.type === 'assistant' || obj.type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') {
      frag.appendChild(row(obj.type, content));
      return frag;
    }
    if (!Array.isArray(content)) return frag;

    for (const part of content) {
      if (part?.type === 'text' && part.text?.trim()) {
        frag.appendChild(row('claude', markdownBlock(part.text)));
      } else if (part?.type === 'thinking') {
        frag.appendChild(row('thinking', preview(part.thinking), 'note'));
      } else if (part?.type === 'tool_use') {
        const body = document.createElement('span');
        body.textContent = part.name ?? 'tool';
        const pre = document.createElement('pre');
        pre.textContent = preview(part.input, 400);
        body.appendChild(pre);
        frag.appendChild(row('tool', body, 'tool'));
      } else if (part?.type === 'tool_result') {
        frag.appendChild(
          row('result', preview(part.content, 400), part.is_error ? 'err' : 'note'),
        );
      }
    }
    return frag;
  }

  // 最終応答は別枠の「回答」セクション（renderAnswer）が専任で表示する。
  // 実行ログ側で重ねて出すと同じ内容が二重に表示されるので、ここでは出さない。
  if (obj.type === 'result') return frag;

  // レート上限はアカウント使用状況 API から別途取得しており、この行は
  // 使っていない。生の JSON を出しても意味が無いので実行ログには出さない。
  if (obj.type === 'rate_limit_event') return frag;

  frag.appendChild(row(obj.type ?? 'event', preview(obj), 'note'));
  return frag;
}

function renderEvent(event) {
  const { kind, data } = event;

  if (kind === 'start') {
    const mode = data.sessionMode === 'new' ? '新規セッション' : 'セッション継続';
    const bits = [mode, short(data.sessionId)];
    if (data.model) bits.push(data.model);
    const body = document.createElement('span');
    body.textContent = bits.join(' · ');
    const pre = document.createElement('pre');
    pre.textContent = data.prompt;
    body.appendChild(pre);
    return row('投入', body, 'note');
  }

  if (kind === 'stream') return renderStreamJson(data);
  if (kind === 'stderr') return row('stderr', data.text.trimEnd(), 'err');
  if (kind === 'raw') return row('raw', data.line, 'note');
  if (kind === 'cancel') return row('停止', '停止を要求しました', 'note');

  if (kind === 'end') {
    if (data.error) return row('終了', `エラー: ${data.error}`, 'err');
    if (data.cancelled) return row('終了', `キャンセルされました · ${duration(data.durationMs)}`, 'err');
    const ok = data.exitCode === 0;
    const label = ok ? '完了' : `終了コード ${data.exitCode}`;
    return row('終了', `${label} · ${duration(data.durationMs)}`, ok ? 'done' : 'err');
  }

  return null;
}

/* ------------------------------ SSE streams ------------------------------ */

function appendEvent(name, event) {
  const card = cards.get(name);
  if (!card) return;
  const node = renderEvent(event);
  if (!node) return;

  const box = card.els.stream;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.appendChild(node);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** 回答欄を空にする。実行ログと違い、直近 1 件だけを残したいので毎回作り直す。 */
function resetAnswer(card) {
  card.els.answer.textContent = '';
  card.els.answer.classList.remove('err');
  card.els.answerWrap.hidden = true;
}

/** 最終応答（stream-json の result）だけを回答欄に反映する。追記ではなく置き換え。 */
function renderAnswer(card, obj) {
  const box = card.els.answer;
  box.textContent = '';
  box.classList.toggle('err', Boolean(obj.is_error));

  if (obj.is_error) {
    box.textContent = `失敗: ${preview(obj.result)}`;
  } else if (typeof obj.result === 'string') {
    box.appendChild(markdownBlock(obj.result));
  } else {
    box.textContent = preview(obj.result, 2000);
  }

  card.els.answerWrap.hidden = false;
}

function closeStream(name) {
  const es = streams.get(name);
  if (es) {
    es.close();
    streams.delete(name);
  }
}

function openStream(name) {
  closeStream(name);

  const card = cards.get(name);
  if (!card) return;

  // サーバが最初にこれまでのイベントを再生するので、まず空にしてから受け直す。
  card.els.stream.textContent = '';
  card.els.streamWrap.hidden = false;
  card.els.streamStatus.textContent = '接続中…';
  resetAnswer(card);

  const es = new EventSource(`/api/containers/${encodeURIComponent(name)}/task/stream${tokenQueryParam()}`);
  streams.set(name, es);

  // サーバは接続のたびに全イベントを再生する。EventSource は切断時に自動再接続
  // するので、開くたびに消さないと再接続のたびにログが二重三重になる。
  es.addEventListener('open', () => {
    card.els.stream.textContent = '';
    card.els.streamStatus.textContent = '受信中';
    resetAnswer(card);
  });

  for (const kind of ['start', 'stream', 'stderr', 'raw', 'cancel', 'end']) {
    es.addEventListener(kind, (ev) => {
      card.els.streamStatus.textContent = '受信中';
      const event = JSON.parse(ev.data);
      appendEvent(name, event);
      if (kind === 'stream' && event.data?.type === 'result') {
        renderAnswer(card, event.data);
      }
    });
  }

  es.addEventListener('closed', () => {
    // 明示的に閉じないと EventSource が自動再接続してしまう。
    closeStream(name);
    card.els.streamStatus.textContent = '完了';
    refresh();
  });

  es.onerror = () => {
    card.els.streamStatus.textContent = '切断';
  };
}

/* -------------------------------- cards -------------------------------- */

function createCard(name, role) {
  const root = template.content.firstElementChild.cloneNode(true);
  const q = (sel) => root.querySelector(sel);

  const els = {
    title: q('.card-title'),
    name: q('.card-name'),
    character: q('.character'),
    characterFace: q('.character-face'),
    roleBadge: q('.role-badge'),
    approvalBadge: q('.approval-badge'),
    pill: q('.pill'),
    pillText: q('.pill-text'),
    state: q('.m-state'),
    activity: q('.m-activity'),
    session: q('.m-session'),
    model: q('.m-model'),
    auth: q('.m-auth'),
    cpu: q('.m-cpu'),
    mem: q('.m-mem'),
    workspace: q('.m-workspace'),
    vault: q('.m-vault'),
    gauges: q('.gauges'),
    authNotice: q('.auth-notice'),
    configNotice: q('.config-notice'),
    authInline: q('[data-action="auth-inline"]'),
    actions: root.querySelectorAll('.actions button[data-action]'),
    form: q('.composer'),
    textarea: q('.composer textarea'),
    newSession: q('.new-session'),
    templateSelect: q('.template-select'),
    modelSelect: q('.model-select'),
    send: q('.send'),
    queueList: q('.queue-list'),
    answerWrap: q('.answer-wrap'),
    answer: q('.answer'),
    streamWrap: q('.stream-wrap'),
    stream: q('.stream'),
    streamStatus: q('.stream-status'),
    cancel: q('.cancel'),
  };

  for (const button of els.actions) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'history') return openHistory(name, els.title.textContent);
      if (action === 'auth') return openAuth(name, els.title.textContent);
      if (action === 'skills') return openSkills(name, els.title.textContent);
      if (action === 'diff') return openDiff(name, els.title.textContent);
      if (action === 'config') return openConfigForEdit(name, els.title.textContent);

      button.disabled = true;
      try {
        await api(`/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
        await refresh();
      } catch (err) {
        window.alert(`${action} に失敗しました: ${err.message}`);
      } finally {
        button.disabled = false;
      }
    });
  }

  els.authInline.addEventListener('click', () => openAuth(name, els.title.textContent));

  // 顔は名前だけで決まるので、カード生成時に一度だけ書けばよい。
  els.characterFace.textContent = characterFor(name);

  setupCopyablePath(els.workspace);
  setupCopyablePath(els.vault);

  // テンプレート一覧はカード生成時点の最新値で埋めておく（templates が未取得の
  // 場合は空のまま。loadTemplates() 完了後に renderTemplateSelects() が埋め直す）。
  fillTemplateOptions(els.templateSelect);
  els.templateSelect.addEventListener('change', () => {
    const t = templates.find((item) => item.id === els.templateSelect.value);
    els.templateSelect.value = '';
    if (!t) return;
    els.textarea.value = t.prompt;
    els.textarea.focus();
  });

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = els.textarea.value.trim();
    if (!prompt) return;

    els.send.disabled = true;
    try {
      const result = await api(`/${encodeURIComponent(name)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          newSession: els.newSession.checked,
          model: els.modelSelect.value || undefined,
        }),
      });
      els.textarea.value = '';
      els.newSession.checked = false;
      els.modelSelect.value = '';
      // busy 中の投入はキューに積まれるだけなので、実行中タスクの購読は動かさない。
      if (!result.queued) openStream(name);
      refresh();
    } catch (err) {
      window.alert(`送信に失敗しました: ${err.message}`);
    } finally {
      els.send.disabled = false;
    }
  });

  els.cancel.addEventListener('click', async () => {
    els.cancel.disabled = true;
    try {
      await api(`/${encodeURIComponent(name)}/task`, { method: 'DELETE' });
    } catch (err) {
      window.alert(`停止に失敗しました: ${err.message}`);
      els.cancel.disabled = false;
    }
  });

  // role: master のプロジェクトだけは通常の作業工程カードと混ざらないよう、
  // 画面上部の固定枠（master-panel）に置く。それ以外は今までどおり grid。
  containerFor(role).appendChild(root);
  const card = { root, els };
  cards.set(name, card);
  return card;
}

/** カードの置き先。master 役だけ画面上部の固定枠、それ以外は通常のグリッド。 */
function containerFor(role) {
  return role === 'master' ? masterPanel : grid;
}

/** busy なコンテナに積まれた、実行待ちタスクの一覧。 */
function renderQueue(card, name, queue) {
  const box = card.els.queueList;
  box.hidden = queue.length === 0;
  if (queue.length === 0) {
    box.textContent = '';
    return;
  }

  box.textContent = '';
  box.appendChild(el('div', 'queue-title', `キュー待ち ${queue.length} 件`));

  for (const item of queue) {
    const row = el('div', 'queue-item');
    const body = el('span', 'queue-body', item.prompt);
    const cancelBtn = el('button', 'link-btn', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await api(`/${encodeURIComponent(name)}/tasks/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        window.alert(`取消に失敗しました: ${err.message}`);
        cancelBtn.disabled = false;
      }
    });
    row.append(body, cancelBtn);
    box.appendChild(row);
  }
}

function updateCard(data) {
  const card = cards.get(data.name) ?? createCard(data.name, data.role);
  const { els } = card;

  // role がライブで変わることは稀だが、変わった場合は次回更新時に正しい枠へ
  // 移す（appendChild は既存ノードを新しい親へ再アタッチするだけなので安全）。
  const expectedContainer = containerFor(data.role);
  if (card.root.parentElement !== expectedContainer) expectedContainer.appendChild(card.root);

  els.title.textContent = data.displayName;
  els.name.textContent = data.name;
  els.pill.dataset.activity = data.activity;
  els.pillText.textContent = ACTIVITY_LABEL[data.activity] ?? data.activity;
  els.character.dataset.activity = data.activity;
  els.character.title = ACTIVITY_LABEL[data.activity] ?? data.activity;

  if (data.role && ROLE_LABEL[data.role]) {
    els.roleBadge.hidden = false;
    els.roleBadge.textContent = ROLE_LABEL[data.role];
    els.roleBadge.dataset.role = data.role;
  } else {
    els.roleBadge.hidden = true;
  }
  els.approvalBadge.hidden = !data.requiresApproval;

  els.state.textContent = STATE_LABEL[data.state] ?? data.state;
  els.activity.textContent = data.busy
    ? data.task?.ticketId
      ? `実行中（パイプライン: ${short(data.task.ticketId)}）`
      : '実行中'
    : ago(data.lastActivity);
  els.session.textContent = short(data.task?.sessionId ?? data.latestSessionId);
  els.session.title = data.task?.sessionId ?? data.latestSessionId ?? '';
  els.model.textContent = data.model || 'アカウント既定';

  // 参照フォルダ（workspace / vault のマウント元）。docker-compose.yml の記述を
  // 実際のホストパスへ展開した値なので、Finder やターミナルでそのまま開ける。
  // 長いパスは省略表示されるが、クリックすると全文表示 + クリップボードコピーができる。
  setPathText(els.workspace, data.hostPaths?.workspace);
  setPathText(els.vault, data.hostPaths?.vault);

  // CPU / メモリ使用量。起動中のコンテナのみ取得できる。
  if (data.state === 'running' && data.resources) {
    els.cpu.textContent = `${data.resources.cpuPercent.toFixed(1)}%`;
    const mem = `${formatBytes(data.resources.memUsedBytes)} / ${formatBytes(data.resources.memLimitBytes)}`;
    els.mem.textContent = `${mem} (${data.resources.memPercent.toFixed(1)}%)`;
    els.mem.title = mem;
  } else {
    els.cpu.textContent = '—';
    els.mem.textContent = '—';
    els.mem.title = '';
  }

  const running = data.state === 'running';
  const loggedIn = Boolean(data.auth?.loggedIn);

  const writable = data.configWritable !== false;

  els.auth.textContent = !running ? '—' : loggedIn ? 'ログイン済み' : '未ログイン';
  els.auth.className = `m-auth ${running ? (loggedIn ? 'ok' : 'no') : ''}`;
  els.configNotice.hidden = !running || writable;
  // 書き込めない場合は原因がそちらなので、ログイン案内は出さない。
  els.authNotice.hidden = !running || loggedIn || !writable;

  renderGauges(card, data);

  for (const button of els.actions) {
    const action = button.dataset.action;
    if (action === 'start') button.disabled = running || data.state === 'missing';
    else if (action === 'stop' || action === 'restart') button.disabled = !running;
    else if (action === 'history' || action === 'auth' || action === 'skills' || action === 'diff') button.disabled = !running;
    // 'config' はコンテナの起動状態に関係なく常に操作可能（ファイル編集のみのため）。
  }

  const canSend = running && loggedIn;
  // busy 中でも送信は許可する（自動でキューに積まれる）。ボタンの文言だけ変える。
  els.send.disabled = !canSend;
  els.send.textContent = data.busy ? 'キューに追加' : '送信';
  els.textarea.disabled = !canSend;
  els.textarea.placeholder = !running
    ? 'コンテナを起動すると指示を出せます'
    : !loggedIn
      ? 'ログインすると指示を出せます'
      : 'このコンテナの Claude に指示を出す…';

  els.cancel.hidden = !data.busy;
  els.cancel.disabled = Boolean(data.task?.cancelRequested);
  els.cancel.textContent = data.task?.cancelRequested ? '停止処理中…' : '停止';

  renderQueue(card, data.name, data.queue ?? []);

  // 実行中なのに未購読なら（ページ再読み込み後など）、途中から追いかける。
  if (data.busy && !streams.has(data.name)) openStream(data.name);

  if (!data.busy && !streams.has(data.name) && data.task) {
    els.streamStatus.textContent = data.task.error
      ? 'エラー終了'
      : data.task.exitCode === 0
        ? '完了'
        : `終了コード ${data.task.exitCode}`;
  }
}

/* --------------------------------- auth --------------------------------- */

const authDialog = document.getElementById('auth-dialog');
const authTitle = document.getElementById('auth-title');
const authBody = document.getElementById('auth-body');

let authTarget = null;
let authTimer = null;
let authSignature = null;

document.getElementById('auth-close').addEventListener('click', () => authDialog.close());

authDialog.addEventListener('close', () => {
  clearInterval(authTimer);
  authTimer = null;
  authTarget = null;
  authSignature = null;
  refresh();
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function authStep(label, ...children) {
  const wrap = el('div', 'auth-step');
  if (label) wrap.appendChild(el('span', 'step-label', label));
  wrap.append(...children);
  return wrap;
}

async function authAction(path, options) {
  try {
    return await api(`/${encodeURIComponent(authTarget)}${path}`, options);
  } catch (err) {
    window.alert(err.message);
    return null;
  }
}

function renderAuth(state) {
  const phase = state.login?.phase ?? 'idle';
  authBody.textContent = '';

  if (phase === 'awaiting_code') {
    if (state.login.error) {
      authBody.appendChild(el('p', 'auth-result bad', state.login.error));
    }

    const link = el('a', 'auth-url', state.login.url);
    link.href = state.login.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    authBody.appendChild(
      authStep('手順 1', el('p', null, '次のリンクを開いて Anthropic アカウントで認証してください。'), link),
    );

    const input = el('input');
    input.type = 'text';
    input.placeholder = '認証後に表示されたコードを貼り付け';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const submit = el('button', 'send', '送信');
    const row = el('div', 'code-row');
    row.append(input, submit);

    const send = async () => {
      const code = input.value.trim();
      if (!code) return;
      submit.disabled = true;
      input.value = '';
      const next = await authAction('/auth/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (next) pollAuth();
      else submit.disabled = false;
    };

    submit.addEventListener('click', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });

    authBody.appendChild(
      authStep('手順 2', el('p', null, 'ブラウザに表示されたコードをここに貼り付けます。'), row),
    );
    authBody.appendChild(
      el('p', 'auth-note', 'コードはコンテナ内の CLI へ渡されるだけで、manager は保存もログ出力もしません。'),
    );

    const cancel = el('button', null, 'キャンセル');
    cancel.addEventListener('click', async () => {
      await authAction('/auth/login', { method: 'DELETE' });
      pollAuth();
    });
    authBody.appendChild(cancel);
    input.focus();
    return;
  }

  if (phase === 'starting') {
    authBody.appendChild(authStep(null, el('p', null, '認証 URL を取得しています…')));
    return;
  }

  if (phase === 'verifying') {
    authBody.appendChild(authStep(null, el('p', null, 'コードを確認しています…')));
    return;
  }

  if (phase === 'success') {
    authBody.appendChild(el('p', 'auth-result ok', 'ログインしました。'));
  } else if (phase === 'error') {
    authBody.appendChild(el('p', 'auth-result bad', state.login.error ?? 'ログインに失敗しました。'));
  }

  if (state.loggedIn) {
    authBody.appendChild(
      authStep('状態',
        el('p', null, `ログイン済み（${state.authMethod}${state.apiProvider ? ` · ${state.apiProvider}` : ''}）`)),
    );

    const out = el('button', null, 'ログアウト');
    out.addEventListener('click', async () => {
      out.disabled = true;
      await authAction('/auth/logout', { method: 'POST' });
      pollAuth();
    });
    authBody.appendChild(out);
    return;
  }

  authBody.appendChild(
    authStep('状態',
      el('p', null, 'このコンテナはまだ Claude にログインしていません。'),
      el('p', 'auth-note',
        'ログインを開始すると、コンテナ内で claude auth login が動き、認証 URL がここに表示されます。認証はあなた自身のブラウザと Anthropic のサイトで完結します。')),
  );

  const start = el('button', 'send', 'ログインを開始');
  start.addEventListener('click', async () => {
    start.disabled = true;
    authBody.textContent = '';
    authBody.appendChild(authStep(null, el('p', null, '認証 URL を取得しています…')));
    const next = await authAction('/auth/login', { method: 'POST' });
    if (next) pollAuth();
  });
  authBody.appendChild(start);
}

async function pollAuth() {
  if (!authTarget) return;
  try {
    const state = await api(`/${encodeURIComponent(authTarget)}/auth`);

    // 表示内容が変わっていないのに描き直すと、貼り付け途中のコードが消えてしまう。
    const signature = [
      state.login?.phase ?? 'idle',
      state.login?.url ?? '',
      state.login?.error ?? '',
      state.loggedIn,
    ].join('|');

    if (signature !== authSignature) {
      authSignature = signature;
      renderAuth(state);
    }

    const phase = state.login?.phase ?? 'idle';
    const active = ['starting', 'awaiting_code', 'verifying'].includes(phase);

    // 進行中のときだけ短い間隔で追いかける。
    clearInterval(authTimer);
    authTimer = active ? setInterval(pollAuth, 2000) : null;
  } catch (err) {
    authSignature = null;
    authBody.textContent = '';
    authBody.appendChild(el('p', 'auth-result bad', `取得に失敗しました: ${err.message}`));
  }
}

function openAuth(name, displayName) {
  authTarget = name;
  authSignature = null;
  authTitle.textContent = `${displayName} — 認証`;
  authBody.textContent = '';
  authBody.appendChild(el('p', null, '読み込み中…'));
  authDialog.showModal();
  pollAuth();
}

/* ------------------------------- history ------------------------------- */

const dialog = document.getElementById('history-dialog');
const historyTitle = document.getElementById('history-title');
const historyList = document.getElementById('history-list');
const historyView = document.getElementById('history-view');

document.getElementById('history-close').addEventListener('click', () => dialog.close());

function renderTranscript(payload) {
  historyView.textContent = '';

  if (payload.messages.length === 0) {
    historyView.appendChild(el('p', 'hint', 'このセッションにはまだメッセージがありません。'));
    return;
  }

  if (payload.truncated) {
    historyView.appendChild(
      el('p', 'hint', 'セッションが大きいため、末尾のみ表示しています。'),
    );
  }

  for (const message of payload.messages) {
    // el() ヘルパーと名前が衝突しないよう msgEl にしている。
    const msgEl = document.createElement('div');
    msgEl.className = `msg ${message.role}`;

    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = message.ts
      ? `${message.role} · ${new Date(message.ts).toLocaleString('ja-JP')}`
      : message.role;
    msgEl.appendChild(role);

    for (const block of message.blocks) {
      const body = document.createElement('div');
      body.className = 'msg-block';

      if (block.kind === 'text') {
        body.appendChild(markdownBlock(block.text));
      } else if (block.kind === 'thinking') {
        body.className += ' thinking';
        body.textContent = block.text;
      } else if (block.kind === 'tool_use') {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = block.name;
        body.append(chip, document.createTextNode(block.input));
      } else if (block.kind === 'tool_result') {
        const chip = document.createElement('span');
        chip.className = block.ok ? 'chip' : 'chip bad';
        chip.textContent = block.ok ? 'result' : 'error';
        body.append(chip, document.createTextNode(block.text));
      }

      msgEl.appendChild(body);
    }

    historyView.appendChild(msgEl);
  }
}

async function openHistory(name, displayName) {
  historyTitle.textContent = `${displayName} — セッション履歴`;
  historyList.textContent = '読み込み中…';
  historyView.innerHTML = '<p class="hint">左の一覧からセッションを選んでください。</p>';
  dialog.showModal();

  let payload;
  try {
    payload = await api(`/${encodeURIComponent(name)}/sessions`);
  } catch (err) {
    historyList.textContent = `取得に失敗しました: ${err.message}`;
    return;
  }

  historyList.textContent = '';
  if (payload.sessions.length === 0) {
    historyList.innerHTML = '<p class="hint">セッションはまだありません。</p>';
    return;
  }

  const buttons = [];
  for (const session of payload.sessions) {
    const row = el('div', 'session-row');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-btn';

    const sid = document.createElement('span');
    sid.className = 'sid';
    sid.textContent = short(session.id);

    const meta = document.createElement('span');
    meta.className = 'smeta';
    const kb = Math.max(1, Math.round(session.bytes / 1024));
    meta.textContent = `${ago(session.mtime)} · ${kb}KB${session.id === payload.currentSessionId ? ' · 現在' : ''}`;

    button.append(sid, meta);
    button.addEventListener('click', async () => {
      for (const other of buttons) other.setAttribute('aria-current', String(other === button));
      historyView.textContent = '';
      historyView.appendChild(el('p', 'hint', '読み込み中…'));
      try {
        renderTranscript(await api(`/${encodeURIComponent(name)}/sessions/${session.id}`));
      } catch (err) {
        // err.message にはコンテナ側の出力が混ざりうるので、HTML として解釈させない。
        historyView.textContent = '';
        historyView.appendChild(el('p', 'hint', `読み込みに失敗しました: ${err.message}`));
      }
    });

    // 次にこのコンテナへタスクを投入したとき、最新セッションではなくこの
    // セッションから --resume させたい場合に使う（最新でないセッションを
    // 手動で選び直すための唯一の手段）。
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'link-btn resume-btn';
    resumeBtn.textContent = 'ここから再開';
    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      try {
        await api(`/${encodeURIComponent(name)}/sessions/${session.id}/resume`, { method: 'POST' });
        resumeBtn.textContent = '設定しました';
        setTimeout(() => {
          resumeBtn.textContent = 'ここから再開';
          resumeBtn.disabled = false;
        }, 2000);
      } catch (err) {
        window.alert(`再開の設定に失敗しました: ${err.message}`);
        resumeBtn.disabled = false;
      }
    });

    row.append(button, resumeBtn);
    buttons.push(button);
    historyList.appendChild(row);
  }

  buttons[0].click();
}

/* ---------------------------- diff rendering ---------------------------- */

/**
 * unified diff テキストを行単位に色分けした <pre> にする。
 * レビュー工程（Skills / パイプライン成果物）と、カードの「差分」ボタンの
 * 両方から共有で使う。
 */
function renderDiffText(text) {
  const pre = el('pre', 'diff-view');
  if (!text) {
    pre.appendChild(el('span', 'diff-line', '（差分はありません）'));
    return pre;
  }
  for (const line of text.split('\n')) {
    const span = document.createElement('span');
    span.className = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---')) span.classList.add('diff-file');
    else if (line.startsWith('@@')) span.classList.add('diff-hunk');
    else if (line.startsWith('+')) span.classList.add('diff-add');
    else if (line.startsWith('-')) span.classList.add('diff-del');
    span.textContent = line;
    pre.append(span, document.createTextNode('\n'));
  }
  return pre;
}

const diffDialog = document.getElementById('diff-dialog');
const diffTitle = document.getElementById('diff-title');
const diffBody = document.getElementById('diff-body');

document.getElementById('diff-close').addEventListener('click', () => diffDialog.close());

async function openDiff(name, displayName) {
  diffTitle.textContent = `${displayName} — 差分（workspace の git diff）`;
  diffBody.textContent = '';
  diffBody.appendChild(el('p', 'hint', '読み込み中…'));
  diffDialog.showModal();

  try {
    const data = await api(`/${encodeURIComponent(name)}/diff`);
    diffBody.textContent = '';
    if (!data.isRepo) {
      diffBody.appendChild(el('p', 'hint', data.message || 'このプロジェクトは git リポジトリではありません。'));
      return;
    }
    if (!data.diff) {
      diffBody.appendChild(el('p', 'hint', '未コミットの変更はありません。'));
      return;
    }
    if (data.stat) diffBody.appendChild(el('pre', 'diff-stat', data.stat));
    diffBody.appendChild(renderDiffText(data.diff));
  } catch (err) {
    diffBody.textContent = '';
    diffBody.appendChild(el('p', 'hint', `取得に失敗しました: ${err.message}`));
  }
}

/* -------------------------------- skills -------------------------------- */

const skillsDialog = document.getElementById('skills-dialog');
const skillsTitle = document.getElementById('skills-title');
const skillsBody = document.getElementById('skills-body');

document.getElementById('skills-close').addEventListener('click', () => skillsDialog.close());

const SKILL_SOURCE_LABEL = {
  project: 'プロジェクト固有（.claude/skills）',
  personal: '個人（このコンテナの ~/.claude/skills）',
  other: 'その他',
};

/** source と（プラグインなら）group ごとにグルーピングした見出しを作る。 */
function skillGroupLabel(skill) {
  if (skill.source === 'plugin') return `プラグイン: ${skill.group ?? '不明'}`;
  return SKILL_SOURCE_LABEL[skill.source] ?? skill.source;
}

function renderSkills(skills) {
  skillsBody.textContent = '';

  if (skills.length === 0) {
    skillsBody.appendChild(
      el('p', 'hint', 'SKILL.md が見つかりませんでした（プロジェクト / 個人 / プラグインのいずれにも未登録です）。'),
    );
    return;
  }

  const groups = new Map();
  for (const skill of skills) {
    const label = skillGroupLabel(skill);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(skill);
  }

  for (const [label, list] of groups) {
    const section = el('section', 'skill-group');
    section.appendChild(el('h4', 'skill-group-title', label));

    for (const skill of list) {
      const item = el('div', 'skill-item');
      item.appendChild(el('div', 'skill-name', skill.name));
      if (skill.description) item.appendChild(el('p', 'skill-desc', skill.description));
      item.appendChild(el('p', 'skill-path mono', skill.path));
      section.appendChild(item);
    }

    skillsBody.appendChild(section);
  }
}

let skillsTarget = null;

async function refreshSkillsList() {
  skillsBody.textContent = '';
  skillsBody.appendChild(el('p', 'hint', '読み込み中…'));
  try {
    const { skills } = await api(`/${encodeURIComponent(skillsTarget)}/skills`);
    renderSkills(skills);
  } catch (err) {
    skillsBody.textContent = '';
    skillsBody.appendChild(el('p', 'hint', `取得に失敗しました: ${err.message}`));
  }
}

async function openSkills(name, displayName) {
  skillsTarget = name;
  skillsTitle.textContent = `${displayName} — Skills`;
  await refreshSkillsList();
  skillsDialog.showModal();
}

/* --------------------------- skill 作成フォーム --------------------------- */

const skillForm = document.getElementById('skill-form');
const skillRoleSelect = document.getElementById('skill-role-select');

let skillRoleTemplates = {};

async function loadSkillRoleTemplates() {
  try {
    const data = await apiSkillTemplates('/');
    skillRoleTemplates = data.templates ?? {};
  } catch {
    skillRoleTemplates = {};
  }
  for (const [role, tpl] of Object.entries(skillRoleTemplates)) {
    skillRoleSelect.appendChild(new Option(tpl.title, role));
  }
}
loadSkillRoleTemplates();

skillRoleSelect.addEventListener('change', () => {
  const tpl = skillRoleTemplates[skillRoleSelect.value];
  if (!tpl) return;
  skillForm.elements.slug.value = tpl.slug;
  skillForm.elements.content.value = tpl.content;
});

skillForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!skillsTarget) return;
  const fd = new FormData(skillForm);
  const slug = String(fd.get('slug') ?? '').trim();
  const content = String(fd.get('content') ?? '');
  if (!slug || !content.trim()) return;

  const submitBtn = skillForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await api(`/${encodeURIComponent(skillsTarget)}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, content }),
    });
    await refreshSkillsList();
  } catch (err) {
    window.alert(`保存に失敗しました: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---------------------------- container config ---------------------------- */

const configDialog = document.getElementById('config-dialog');
const configTitle = document.getElementById('config-title');
const configForm = document.getElementById('config-form');
const configVault = document.getElementById('config-vault');
const configPending = document.getElementById('config-pending');
const configBuild = document.getElementById('config-build');
const configApplyBtn = document.getElementById('config-apply-btn');
const configLog = document.getElementById('config-log');
const configSave = document.getElementById('config-save');

let configMode = 'add'; // 'add' | 'edit'
let configTarget = null; // 編集対象のサービス名（add モードでは null）

document.getElementById('config-close').addEventListener('click', () => configDialog.close());

// 役割（設計/実装/レビュー/テスト）ごとの permissionMode / allowedTools のおすすめ値。
// 「プリセットを適用」ボタンから、保存前のフォーム値としてのみ差し込む。
let rolePresets = {};
apiConfig('/role-presets')
  .then((data) => { rolePresets = data.presets ?? {}; })
  .catch(() => { rolePresets = {}; });

document.getElementById('config-apply-role-preset').addEventListener('click', () => {
  const role = configForm.elements.role.value;
  const preset = rolePresets[role];
  if (!preset) {
    window.alert('先に役割を選択してください。');
    return;
  }
  configForm.elements.permissionMode.value = preset.permissionMode;
  configForm.elements.allowedTools.value = (preset.allowedTools ?? []).join(', ');
});

function resetConfigLog() {
  configLog.hidden = true;
  configLog.textContent = '';
}

function openConfigForAdd() {
  configMode = 'add';
  configTarget = null;
  configTitle.textContent = '新しいプロジェクトを追加';
  configForm.reset();
  configForm.elements.name.disabled = false;
  configForm.elements.name.value = '';
  configVault.textContent = '（追加後、既存プロジェクトと同じ vault フォルダが自動で使われます）';
  configPending.hidden = true;
  resetConfigLog();
  configDialog.showModal();
  configForm.elements.name.focus();
}

async function openConfigForEdit(name, displayName) {
  configMode = 'edit';
  configTarget = name;
  configTitle.textContent = `${displayName} — コンテナ設定`;
  configForm.reset();
  configForm.elements.name.value = name;
  configForm.elements.name.disabled = true;
  configPending.hidden = true;
  resetConfigLog();
  configDialog.showModal();

  try {
    const { projects } = await apiConfig('/projects');
    const project = projects.find((p) => p.name === name);
    if (!project) throw new Error('compose 上にこのサービスが見つかりません');

    configForm.elements.displayName.value = project.displayName ?? '';
    configForm.elements.hostPath.value = project.hostWorkspacePath ?? '';
    configForm.elements.role.value = project.role ?? '';
    configForm.elements.requiresApproval.checked = Boolean(project.requiresApproval);
    configForm.elements.permissionMode.value = project.permissionMode ?? 'bypassPermissions';
    configForm.elements.allowedTools.value = (project.allowedTools ?? []).join(', ');
    configForm.elements.model.value = project.model ?? '';
    configVault.textContent = project.hostVaultPathResolved ?? project.hostVaultPath ?? '—';
  } catch (err) {
    configVault.textContent = '—';
    window.alert(`設定の取得に失敗しました: ${err.message}`);
  }
}

configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(configForm);
  const allowedTools = String(fd.get('allowedTools') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    displayName: fd.get('displayName'),
    hostPath: fd.get('hostPath'),
    role: fd.get('role') || '',
    requiresApproval: fd.get('requiresApproval') === 'on',
    permissionMode: fd.get('permissionMode'),
    allowedTools,
    model: fd.get('model'),
  };

  configSave.disabled = true;
  try {
    if (configMode === 'add') {
      await apiConfig('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, name: fd.get('name') }),
      });
    } else {
      await apiConfig(`/projects/${encodeURIComponent(configTarget)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    configPending.hidden = false;
    // 追加直後は一覧にまだ出ていないので、編集モードへ切り替えておく
    // （同じダイアログのまま「適用」できるように）。
    if (configMode === 'add') {
      configMode = 'edit';
      configTarget = fd.get('name');
      configForm.elements.name.disabled = true;
      configTitle.textContent = `${fd.get('displayName') || fd.get('name')} — コンテナ設定`;
    }
  } catch (err) {
    window.alert(`保存に失敗しました: ${err.message}`);
  } finally {
    configSave.disabled = false;
  }
});

configApplyBtn.addEventListener('click', async () => {
  configApplyBtn.disabled = true;
  configLog.hidden = false;
  configLog.textContent = '適用中…（初回のイメージビルドを伴う場合は数分かかることがあります）';
  try {
    const result = await apiConfig('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // configTarget を渡し、このプロジェクトだけを対象にする。省略すると
      // 他の起動中プロジェクトまで再作成対象に含めてしまう。
      body: JSON.stringify({ build: configBuild.checked, service: configTarget }),
    });
    configLog.textContent = result.output || '（出力なし）';
    if (result.ok) {
      configPending.hidden = true;
      refresh();
    }
  } catch (err) {
    configLog.textContent = `適用に失敗しました: ${err.message}`;
  } finally {
    configApplyBtn.disabled = false;
  }
});

document.getElementById('add-project').addEventListener('click', openConfigForAdd);

/* ------------------------------- templates ------------------------------- */

// よく使う指示を、コンテナ横断で使い回せるテンプレートとして保存する。
// manager プロセスのメモリではなくファイル（manager/templates.json）に永続化される。
const apiTemplates = (path, options) => apiCall('/api/templates', path, options);

let templates = [];

/** 1 つの <select> にテンプレート一覧を（プレースホルダ以外を作り直して）反映する。 */
function fillTemplateOptions(select) {
  const current = select.value;
  select.textContent = '';
  select.appendChild(new Option('テンプレートを挿入…', ''));
  for (const t of templates) select.appendChild(new Option(t.title, t.id));
  select.value = templates.some((t) => t.id === current) ? current : '';
}

/** 全カードのテンプレート選択肢を最新の templates で作り直す。 */
function renderTemplateSelects() {
  for (const card of cards.values()) fillTemplateOptions(card.els.templateSelect);
}

async function loadTemplates() {
  try {
    const data = await apiTemplates('/');
    templates = data.templates ?? [];
  } catch {
    templates = [];
  }
  renderTemplateSelects();
}

const templatesDialog = document.getElementById('templates-dialog');
const templateForm = document.getElementById('template-form');
const templateListEl = document.getElementById('template-list');

function renderTemplateList() {
  templateListEl.textContent = '';

  if (templates.length === 0) {
    templateListEl.appendChild(el('li', 'hint', 'まだテンプレートがありません。'));
    return;
  }

  for (const t of templates) {
    const item = el('li', 'template-item');

    const head = el('div', 'template-item-head');
    head.appendChild(el('span', 'template-item-title', t.title));

    const del = el('button', 'link-btn', '削除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await apiTemplates(`/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        await loadTemplates();
        renderTemplateList();
      } catch (err) {
        window.alert(`削除に失敗しました: ${err.message}`);
        del.disabled = false;
      }
    });
    head.appendChild(del);

    item.append(head, el('pre', 'template-item-body', t.prompt));
    templateListEl.appendChild(item);
  }
}

document.getElementById('templates-close').addEventListener('click', () => templatesDialog.close());
document.getElementById('open-templates').addEventListener('click', () => {
  renderTemplateList();
  templatesDialog.showModal();
});

templateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(templateForm);
  const title = String(fd.get('title') ?? '').trim();
  const prompt = String(fd.get('prompt') ?? '').trim();
  if (!title || !prompt) return;

  const submitBtn = templateForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await apiTemplates('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt }),
    });
    templateForm.reset();
    await loadTemplates();
    renderTemplateList();
  } catch (err) {
    window.alert(`保存に失敗しました: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

loadTemplates();

/* -------------------------------- pipeline -------------------------------- */

// 設計 → 実装 → レビュー → テスト → 完了、というチケットのかんばん。
// 「どの工程を誰が担当するか」はサーバ側（containers.config.json の role）が
// 権威を持つので、ここでは /api/pipeline/stages が返す順序・担当者をそのまま使う。

const pipelineDialog = document.getElementById('pipeline-dialog');
const pipelineNewForm = document.getElementById('pipeline-new-form');
const pipelineBoard = document.getElementById('pipeline-board');
const pipelineDetail = document.getElementById('pipeline-detail');
const pipelineMasterInfo = document.getElementById('pipeline-master-info');
const pipelineAutopilotToggle = document.getElementById('pipeline-autopilot-toggle');

let autopilotPaused = false;

pipelineAutopilotToggle.addEventListener('click', async () => {
  pipelineAutopilotToggle.disabled = true;
  try {
    const data = await apiPipeline('/autopilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: !autopilotPaused }),
    });
    autopilotPaused = data.paused;
    renderAutopilotToggle();
  } catch (err) {
    window.alert(`切り替えに失敗しました: ${err.message}`);
  } finally {
    pipelineAutopilotToggle.disabled = false;
  }
});

function renderAutopilotToggle() {
  pipelineAutopilotToggle.hidden = false;
  pipelineAutopilotToggle.textContent = autopilotPaused ? '自動運転を再開する' : '自動運転を一時停止する';
}

document.getElementById('pipeline-close').addEventListener('click', () => pipelineDialog.close());
document.getElementById('open-pipeline').addEventListener('click', () => {
  pipelineDialog.showModal();
  loadPipeline();
});

let pipelineStages = [];
let pipelineTickets = [];
let pipelineSelected = null;

function stageInfo(stage) {
  return pipelineStages.find((s) => s.stage === stage) ?? { stage, label: stage, project: null, displayName: null };
}

async function loadPipeline() {
  try {
    const [stagesData, ticketsData, master, autopilot] = await Promise.all([
      apiPipeline('/stages'),
      apiPipeline('/tickets'),
      apiPipeline('/master'),
      apiPipeline('/autopilot'),
    ]);
    pipelineStages = stagesData.stages ?? [];
    pipelineTickets = ticketsData.tickets ?? [];
    autopilotPaused = Boolean(autopilot.paused);

    if (master.displayName) {
      pipelineMasterInfo.textContent = autopilotPaused
        ? `司令塔: ${master.displayName}（自動運転は一時停止中です）`
        : `司令塔: ${master.displayName}（各工程の完了後に自動で進める/差し戻す/保留を判断します）`;
      renderAutopilotToggle();
    } else {
      pipelineMasterInfo.textContent = 'マスター役が未設定です（コンテナ設定で役割を「マスター」にすると、工程完了後の判断を自動化できます）';
      pipelineAutopilotToggle.hidden = true;
    }
  } catch (err) {
    pipelineBoard.textContent = '';
    pipelineBoard.appendChild(el('p', 'hint', `取得に失敗しました: ${err.message}`));
    return;
  }

  renderPipelineBoard();
  if (pipelineSelected && pipelineTickets.some((t) => t.id === pipelineSelected)) {
    renderPipelineDetail(pipelineSelected);
  } else {
    pipelineSelected = null;
    pipelineDetail.hidden = true;
  }
}

function renderPipelineBoard() {
  pipelineBoard.textContent = '';
  for (const stage of pipelineStages) {
    const col = el('div', 'pipeline-col');
    const head = el('div', 'pipeline-col-head');
    head.appendChild(el('span', 'pipeline-col-label', stage.label));
    head.appendChild(el('span', 'pipeline-col-project', stage.displayName || '担当未設定'));
    col.appendChild(head);

    const list = el('div', 'pipeline-col-list');
    const tickets = pipelineTickets.filter((t) => t.stage === stage.stage);
    for (const ticket of tickets) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pipeline-ticket';
      if (ticket.id === pipelineSelected) card.classList.add('is-selected');
      card.appendChild(el('div', 'pipeline-ticket-title', ticket.title));
      card.appendChild(el('div', 'pipeline-ticket-meta', ago(ticket.updatedAt)));
      card.addEventListener('click', () => {
        pipelineSelected = ticket.id;
        renderPipelineBoard();
        renderPipelineDetail(ticket.id);
      });
      list.appendChild(card);
    }
    if (tickets.length === 0) list.appendChild(el('p', 'hint', '案件なし'));
    col.appendChild(list);
    pipelineBoard.appendChild(col);
  }
}

const HISTORY_KIND_LABEL = {
  created: '作成',
  sent: '送信',
  advanced: '工程を進めた',
  rejected: '差し戻し',
  master_hold: '判断を保留',
  master_error: '判断エラー',
  master_paused: '自動運転を一時停止',
  master_skipped: '自動判断をスキップ',
  master_approval_needed: '承認待ち',
};

// ステージ遷移を伴う履歴（→ の矢印表示）と、そうでない履歴（保留・エラー等）を区別する。
const HISTORY_TRANSITION_KINDS = new Set(['created', 'sent', 'advanced', 'rejected']);

function renderPipelineArtifact(name, content) {
  if (/\.(diff|patch)$/i.test(name)) return renderDiffText(content);
  return markdownBlock(content);
}

async function renderPipelineDetail(id) {
  const ticket = pipelineTickets.find((t) => t.id === id);
  if (!ticket) return;

  pipelineDetail.hidden = false;
  pipelineDetail.textContent = '';

  const order = pipelineStages.map((s) => s.stage);
  const idx = order.indexOf(ticket.stage);
  const nextStage = order[idx + 1];
  const currentInfo = stageInfo(ticket.stage);

  const head = el('div', 'pipeline-detail-head');
  head.appendChild(el('h4', null, ticket.title));
  const del = el('button', 'link-btn', '削除');
  del.type = 'button';
  del.addEventListener('click', async () => {
    if (!window.confirm(`「${ticket.title}」を削除しますか？（/handoff 内の成果物ファイルは残ります）`)) return;
    try {
      await apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}`, { method: 'DELETE' });
      pipelineSelected = null;
      await loadPipeline();
    } catch (err) {
      window.alert(`削除に失敗しました: ${err.message}`);
    }
  });
  head.appendChild(del);
  pipelineDetail.appendChild(head);

  pipelineDetail.appendChild(
    el(
      'p',
      'pipeline-detail-meta',
      `現在: ${currentInfo.label}${currentInfo.displayName ? `（担当: ${currentInfo.displayName}）` : '（担当プロジェクト未設定）'}`,
    ),
  );

  if (ticket.autopilot?.paused) {
    pipelineDetail.appendChild(
      el(
        'p',
        'pipeline-autopilot-paused',
        '自動運転は一時停止中です（差し戻しが繰り返されたため）。成果物を確認し、下のボタンで手動操作すると再開します。',
      ),
    );
  }

  const lastHistory = ticket.history[ticket.history.length - 1];
  if (lastHistory?.kind === 'master_approval_needed') {
    const targetLabel = nextStage ? stageInfo(nextStage).label : '次の工程';
    pipelineDetail.appendChild(
      el(
        'p',
        'pipeline-approval-needed',
        `マスターが「${targetLabel}」への進行を提案しています${lastHistory.note ? `（理由: ${lastHistory.note}）` : ''}。` +
          '内容を確認し、進めてよければ下の「次の工程へ」を押してください。',
      ),
    );
  }

  const noteInput = document.createElement('textarea');
  noteInput.className = 'pipeline-note';
  noteInput.rows = 2;
  noteInput.placeholder = '引き継ぎメモ（任意）';
  pipelineDetail.appendChild(noteInput);

  const actions = el('div', 'pipeline-detail-actions');

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = `${currentInfo.label}へ(再)送信`;
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    try {
      await apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteInput.value.trim() || undefined }),
      });
      await loadPipeline();
    } catch (err) {
      window.alert(`送信に失敗しました: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
    }
  });
  actions.appendChild(sendBtn);

  if (nextStage) {
    const advanceBtn = document.createElement('button');
    advanceBtn.type = 'button';
    advanceBtn.className = 'send';
    advanceBtn.textContent = `次の工程へ（${stageInfo(nextStage).label}）`;
    advanceBtn.addEventListener('click', async () => {
      advanceBtn.disabled = true;
      try {
        await apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}/advance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: noteInput.value.trim() || undefined }),
        });
        await loadPipeline();
      } catch (err) {
        window.alert(`送信に失敗しました: ${err.message}`);
      } finally {
        advanceBtn.disabled = false;
      }
    });
    actions.appendChild(advanceBtn);
  }

  if (idx > 0) {
    const rejectSelect = document.createElement('select');
    for (let i = 0; i < idx; i += 1) {
      const s = order[i];
      rejectSelect.appendChild(new Option(`${stageInfo(s).label}へ差し戻す`, s));
    }
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'ghost';
    rejectBtn.textContent = '差し戻す';
    rejectBtn.addEventListener('click', async () => {
      rejectBtn.disabled = true;
      try {
        await apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toStage: rejectSelect.value, note: noteInput.value.trim() || undefined }),
        });
        await loadPipeline();
      } catch (err) {
        window.alert(`差し戻しに失敗しました: ${err.message}`);
      } finally {
        rejectBtn.disabled = false;
      }
    });
    actions.append(rejectSelect, rejectBtn);
  }

  pipelineDetail.appendChild(actions);

  const usageBox = el('p', 'pipeline-usage', '使用量を読み込み中…');
  pipelineDetail.appendChild(usageBox);
  apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}/usage`)
    .then((usage) => {
      if (!usage || usage.tasks === 0) {
        usageBox.textContent = 'このチケットではまだタスクが完了していません。';
        return;
      }
      usageBox.textContent =
        `このチケットの累計使用量: $${usage.costUsd.toFixed(4)} ・ ` +
        `トークン ${(usage.inputTokens + usage.outputTokens).toLocaleString('ja-JP')} ・ ` +
        `タスク ${usage.tasks} 件`;
    })
    .catch(() => {
      usageBox.textContent = '使用量の取得に失敗しました。';
    });

  const historyBox = el('div', 'pipeline-history');
  historyBox.appendChild(el('div', 'pipeline-subhead', '履歴'));
  for (const h of [...ticket.history].reverse()) {
    const row = el('div', 'pipeline-history-row');
    const label = HISTORY_KIND_LABEL[h.kind] ?? h.kind;
    const actorTag = h.actor === 'master' ? '（マスター）' : '';
    const text = HISTORY_TRANSITION_KINDS.has(h.kind)
      ? `${label}${actorTag} → ${stageInfo(h.stage).label}${h.project ? `（${h.project}）` : ''}`
      : `${label}${actorTag}（${stageInfo(h.stage).label}）`;
    row.appendChild(el('span', 'mono', new Date(h.at).toLocaleString('ja-JP')));
    row.appendChild(el('span', null, ` ${text}`));
    if (h.note) row.appendChild(el('div', 'pipeline-history-note', h.note));
    historyBox.appendChild(row);
  }
  pipelineDetail.appendChild(historyBox);

  const artifactsBox = el('div', 'pipeline-artifacts');
  artifactsBox.appendChild(el('div', 'pipeline-subhead', '成果物（/handoff）'));
  const artifactsList = el('div', 'pipeline-artifacts-list');
  const artifactsView = el('div', 'pipeline-artifacts-view');
  artifactsBox.append(artifactsList, artifactsView);
  pipelineDetail.appendChild(artifactsBox);

  try {
    const { artifacts } = await apiPipeline(`/tickets/${encodeURIComponent(ticket.id)}/artifacts`);
    if (artifacts.length === 0) {
      artifactsList.appendChild(el('p', 'hint', 'まだありません。'));
    }
    for (const a of artifacts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = a.name;
      btn.addEventListener('click', async () => {
        artifactsView.textContent = '読み込み中…';
        try {
          const { content } = await apiPipeline(
            `/tickets/${encodeURIComponent(ticket.id)}/artifacts/${encodeURIComponent(a.name)}`,
          );
          artifactsView.textContent = '';
          artifactsView.appendChild(renderPipelineArtifact(a.name, content));
        } catch (err) {
          artifactsView.textContent = `読み込みに失敗しました: ${err.message}`;
        }
      });
      artifactsList.appendChild(btn);
    }
  } catch {
    artifactsList.appendChild(el('p', 'hint', '取得に失敗しました。'));
  }
}

pipelineNewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(pipelineNewForm);
  const title = String(fd.get('title') ?? '').trim();
  if (!title) return;

  const submitBtn = pipelineNewForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const ticket = await apiPipeline('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    pipelineNewForm.reset();
    pipelineSelected = ticket.id;
    await loadPipeline();
  } catch (err) {
    window.alert(`追加に失敗しました: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

/* -------------------------------- polling -------------------------------- */

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  pollEl.classList.add('active');

  try {
    const { containers } = await api('/');

    emptyEl.hidden = containers.length > 0;
    bannerEl.hidden = !containers.some((c) => c.permissionMode === 'bypassPermissions');
    masterPanelEmpty.hidden = containers.some((c) => c.role === 'master');

    for (const container of containers) updateCard(container);

    const running = containers.filter((c) => c.state === 'running').length;
    const working = containers.filter((c) => c.busy).length;
    summaryEl.textContent = `${containers.length} 台 · 起動中 ${running} · 実行中 ${working}`;
  } catch (err) {
    summaryEl.textContent = `manager に接続できません: ${err.message}`;
  } finally {
    pollEl.classList.remove('active');
    refreshing = false;
  }
}

document.getElementById('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, POLL_MS);
