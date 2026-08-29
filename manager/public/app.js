'use strict';

import { markdownBlock } from './markdown.js';

const POLL_MS = 5000;

const grid = document.getElementById('grid');
const template = document.getElementById('card-template');
const summaryEl = document.getElementById('summary');
const pollEl = document.getElementById('poll-state');
const bannerEl = document.getElementById('banner');
const emptyEl = document.getElementById('empty');

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

async function apiCall(base, path, options) {
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

const api = (path, options) => apiCall('/api/containers', path, options);
const apiConfig = (path, options) => apiCall('/api/config', path, options);

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
    const body = document.createElement('span');
    body.textContent = `${mode} · ${short(data.sessionId)}`;
    const pre = document.createElement('pre');
    pre.textContent = data.prompt;
    body.appendChild(pre);
    return row('投入', body, 'note');
  }

  if (kind === 'stream') return renderStreamJson(data);
  if (kind === 'stderr') return row('stderr', data.text.trimEnd(), 'err');
  if (kind === 'raw') return row('raw', data.line, 'note');

  if (kind === 'end') {
    if (data.error) return row('終了', `エラー: ${data.error}`, 'err');
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

  const es = new EventSource(`/api/containers/${encodeURIComponent(name)}/task/stream`);
  streams.set(name, es);

  // サーバは接続のたびに全イベントを再生する。EventSource は切断時に自動再接続
  // するので、開くたびに消さないと再接続のたびにログが二重三重になる。
  es.addEventListener('open', () => {
    card.els.stream.textContent = '';
    card.els.streamStatus.textContent = '受信中';
    resetAnswer(card);
  });

  for (const kind of ['start', 'stream', 'stderr', 'raw', 'end']) {
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

function createCard(name) {
  const root = template.content.firstElementChild.cloneNode(true);
  const q = (sel) => root.querySelector(sel);

  const els = {
    title: q('.card-title'),
    name: q('.card-name'),
    character: q('.character'),
    characterFace: q('.character-face'),
    pill: q('.pill'),
    pillText: q('.pill-text'),
    state: q('.m-state'),
    activity: q('.m-activity'),
    session: q('.m-session'),
    auth: q('.m-auth'),
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
    send: q('.send'),
    answerWrap: q('.answer-wrap'),
    answer: q('.answer'),
    streamWrap: q('.stream-wrap'),
    stream: q('.stream'),
    streamStatus: q('.stream-status'),
  };

  for (const button of els.actions) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'history') return openHistory(name, els.title.textContent);
      if (action === 'auth') return openAuth(name, els.title.textContent);
      if (action === 'skills') return openSkills(name, els.title.textContent);
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

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = els.textarea.value.trim();
    if (!prompt) return;

    els.send.disabled = true;
    try {
      await api(`/${encodeURIComponent(name)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, newSession: els.newSession.checked }),
      });
      els.textarea.value = '';
      els.newSession.checked = false;
      openStream(name);
      refresh();
    } catch (err) {
      window.alert(`送信に失敗しました: ${err.message}`);
      els.send.disabled = false;
    }
  });

  grid.appendChild(root);
  const card = { root, els };
  cards.set(name, card);
  return card;
}

function updateCard(data) {
  const card = cards.get(data.name) ?? createCard(data.name);
  const { els } = card;

  els.title.textContent = data.displayName;
  els.name.textContent = data.name;
  els.pill.dataset.activity = data.activity;
  els.pillText.textContent = ACTIVITY_LABEL[data.activity] ?? data.activity;
  els.character.dataset.activity = data.activity;
  els.character.title = ACTIVITY_LABEL[data.activity] ?? data.activity;

  els.state.textContent = STATE_LABEL[data.state] ?? data.state;
  els.activity.textContent = data.busy ? '実行中' : ago(data.lastActivity);
  els.session.textContent = short(data.task?.sessionId ?? data.latestSessionId);
  els.session.title = data.task?.sessionId ?? data.latestSessionId ?? '';

  // 参照フォルダ（workspace / vault のマウント元）。docker inspect の実マウントに基づく
  // ので、「今動いているコンテナが実際にどのホストフォルダを見ているか」を表す。
  const wsMount = (data.mounts ?? []).find((m) => m.destination === data.workspacePath);
  const vaultMount = (data.mounts ?? []).find((m) => m.destination === '/vault');
  els.workspace.textContent = wsMount?.source ?? '—';
  els.workspace.title = wsMount?.source ?? '';
  els.vault.textContent = vaultMount?.source ?? '—';
  els.vault.title = vaultMount?.source ?? '';

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
    else if (action === 'history' || action === 'auth' || action === 'skills') button.disabled = !running;
    // 'config' はコンテナの起動状態に関係なく常に操作可能（ファイル編集のみのため）。
  }

  const canSend = running && loggedIn;
  els.send.disabled = !canSend || data.busy;
  els.textarea.disabled = !canSend;
  els.textarea.placeholder = !running
    ? 'コンテナを起動すると指示を出せます'
    : !loggedIn
      ? 'ログインすると指示を出せます'
      : 'このコンテナの Claude に指示を出す…';

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

    buttons.push(button);
    historyList.appendChild(button);
  }

  buttons[0].click();
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

async function openSkills(name, displayName) {
  skillsTitle.textContent = `${displayName} — Skills`;
  skillsBody.textContent = '';
  skillsBody.appendChild(el('p', 'hint', '読み込み中…'));
  skillsDialog.showModal();

  try {
    const { skills } = await api(`/${encodeURIComponent(name)}/skills`);
    renderSkills(skills);
  } catch (err) {
    skillsBody.textContent = '';
    skillsBody.appendChild(el('p', 'hint', `取得に失敗しました: ${err.message}`));
  }
}

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
    configForm.elements.permissionMode.value = project.permissionMode ?? 'bypassPermissions';
    configForm.elements.allowedTools.value = (project.allowedTools ?? []).join(', ');
    configVault.textContent = project.hostVaultPath ?? '—';
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
    permissionMode: fd.get('permissionMode'),
    allowedTools,
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
