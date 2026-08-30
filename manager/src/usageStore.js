import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 使用量（コスト・トークン）とレート上限を集計・保持する。
 *
 * 出典が 2 種類ある:
 *  - コスト・トークン集計（totals）: `claude -p --output-format stream-json` の
 *    `result` イベント。CLI 自身が課金対象として算出した値をそのまま使う。
 *    manager 側で単価を掛け直したりはしない（単価表を持つと必ず古くなるため）。
 *    `assistant` イベントにもターンごとの usage が乗るが、実測すると同一 API
 *    呼び出しの重複や、ストリーミング途中の未確定値（output_tokens が最終値
 *    よりかなり小さい）を含み、積み上げに使うと実態と異なる数字になるため
 *    採用していない。
 *  - レート上限（rateLimits）: `https://api.anthropic.com/api/oauth/usage` を
 *    remoteUsage.js が定期ポーリングして書き込む。CLI の `rate_limit_event`
 *    （上限に近い窓しか通知されない）に頼っていた旧実装と違い、この API は
 *    ログインさえしていれば実行中のタスクが無くても常に最新の利用率が取れる。
 *
 * コスト・トークン集計（totals / ticketTotals）は他の *Store.js と同じ考え方で
 * JSON ファイルへ永続化し、manager コンテナを再作成しても消えないようにしている
 * （レート上限は Anthropic 側が持つ状態を都度取り直すだけなので永続化しない）。
 * 恒久的な請求額は Anthropic のコンソールが唯一の正となる。
 *
 * `onUsageChange` で購読者に変更を即座に通知し、ヘッダーは 5 秒ポーリングを
 * 待たずに SSE で更新できるようにしている（routes/containers.js の
 * `/usage/stream` 参照）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const mountedDir = path.join(process.env.COMPOSE_PROJECT_DIR ?? '/compose-project', 'manager');

export const usagePath = process.env.USAGE_FILE
  ? path.resolve(process.env.USAGE_FILE)
  : existsSync(mountedDir)
    ? path.join(mountedDir, 'usage.json')
    : path.join(appRoot, 'usage.json');

function loadPersisted() {
  if (!existsSync(usagePath)) return { totals: {}, ticketTotals: {}, startedAt: Date.now() };
  try {
    const data = JSON.parse(readFileSync(usagePath, 'utf8'));
    return {
      totals: data?.totals && typeof data.totals === 'object' ? data.totals : {},
      ticketTotals: data?.ticketTotals && typeof data.ticketTotals === 'object' ? data.ticketTotals : {},
      // 記録が始まった最初の時刻。UI の「累計」表示の起点として使うため、
      // 再起動のたびに動かしてはいけない（動かすと「since」の意味が壊れる）。
      startedAt: Number.isFinite(data?.startedAt) ? data.startedAt : Date.now(),
    };
  } catch {
    // 書き込み途中などで壊れた状態を一瞬読んでしまった場合は、集計を失うより
    // 空から始める方が安全（次の recordResult で改めて書き直る）。
    return { totals: {}, ticketTotals: {}, startedAt: Date.now() };
  }
}

/** 永続化ファイルの値をそのまま信用せず、欠けたフィールドは既定値で補う。 */
function sanitizeTotal(raw) {
  return { ...emptyTotals(), ...(raw && typeof raw === 'object' ? raw : {}) };
}

const persisted = loadPersisted();
const totals = new Map(Object.entries(persisted.totals).map(([k, v]) => [k, sanitizeTotal(v)])); // コンテナ名 → 累計
const ticketTotals = new Map(
  Object.entries(persisted.ticketTotals).map(([k, v]) => [k, sanitizeTotal(v)]),
); // チケット ID → 累計（コンテナ横断で合算）
const rateLimits = new Map(); // コンテナ名 → { five_hour, seven_day, ... }（永続化しない）
let startedAt = persisted.startedAt;

/**
 * totals / ticketTotals をディスクへ書き戻す。呼び出し頻度はタスク完了時のみ
 * （高々分に数回程度）なので、都度同期書き込みで十分。一時ファイルへ書いてから
 * rename する（pipelineStore.js の saveTicket と同じ理由: 書き込み途中で
 * プロセスが落ちたり、その瞬間を別プロセスが読んだりしても、壊れた/欠けた
 * JSON を掴ませない）。
 */
function persist() {
  const data = {
    totals: Object.fromEntries(totals),
    ticketTotals: Object.fromEntries(ticketTotals),
    startedAt,
  };
  const tmp = `${usagePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, usagePath);
  } catch (err) {
    console.error(`[usageStore] 使用量の永続化に失敗しました: ${err.message}`);
  }
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // SSE クライアント数ぶん購読されるため上限を外す。

/** 使用量またはレート上限が変わるたびに呼ぶ。 */
function notify() {
  bus.emit('change');
}

/** 変更を購読する。返り値を呼ぶと解除できる。 */
export function onUsageChange(listener) {
  bus.on('change', listener);
  return () => bus.off('change', listener);
}

const int = (value) => (Number.isFinite(value) ? Math.trunc(value) : 0);
const num = (value) => (Number.isFinite(value) ? value : 0);

function emptyTotals() {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearches: 0,
    turns: 0,
    tasks: 0,
    lastAt: null,
  };
}

/** result イベントから、UI に出す形の使用量を取り出す。 */
export function extractUsage(result) {
  const usage = result?.usage ?? {};

  const models = [];
  for (const [name, entry] of Object.entries(result?.modelUsage ?? {})) {
    const inputTokens = int(entry?.inputTokens);
    const cacheReadTokens = int(entry?.cacheReadInputTokens);
    const cacheCreationTokens = int(entry?.cacheCreationInputTokens);
    models.push({
      name,
      inputTokens,
      outputTokens: int(entry?.outputTokens),
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: num(Number(entry?.costUSD)),
      contextWindow: Number.isFinite(entry?.contextWindow) ? entry.contextWindow : null,
      // 直近のリクエストが積んだ入力量。コンテキスト消費の目安として使う。
      contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    });
  }
  // コストの大きいものを主モデルとして先頭に置く（UI はこれをバー表示に使う）。
  models.sort((a, b) => b.costUsd - a.costUsd);

  return {
    costUsd: num(Number(result?.total_cost_usd)),
    inputTokens: int(usage.input_tokens),
    outputTokens: int(usage.output_tokens),
    cacheReadTokens: int(usage.cache_read_input_tokens),
    cacheCreationTokens: int(usage.cache_creation_input_tokens),
    webSearches: int(usage.server_tool_use?.web_search_requests),
    turns: int(result?.num_turns),
    durationMs: Number.isFinite(result?.duration_ms) ? result.duration_ms : null,
    durationApiMs: Number.isFinite(result?.duration_api_ms) ? result.duration_api_ms : null,
    serviceTier: typeof usage.service_tier === 'string' ? usage.service_tier : null,
    isError: Boolean(result?.is_error),
    models,
  };
}

/**
 * レート上限を丸ごと置き換える（remoteUsage.js が `/api/oauth/usage` を
 * ポーリングして呼ぶ）。CLI のログから拾う一部の窓だけの通知と違い、
 * この API は毎回すべての窓を返すので、追記ではなく置き換えでよい。
 * 値が変わっていなければ通知しない（30秒おきのポーリングで毎回 SSE を
 * 起こすと、変化のないときまでヘッダーがちらつく）。
 */
export function setRateLimits(name, limits) {
  const current = rateLimits.get(name);
  const next = limits ?? {};
  if (current && JSON.stringify(current) === JSON.stringify(next)) return;

  rateLimits.set(name, next);
  notify();
}

export function rateLimitsFor(name) {
  return rateLimits.get(name) ?? {};
}

/** result イベントを累計へ足し込み、そのタスク分の使用量を返す。 */
export function recordResult(name, result) {
  const usage = extractUsage(result);

  const total = totals.get(name) ?? emptyTotals();
  total.costUsd += usage.costUsd;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheCreationTokens += usage.cacheCreationTokens;
  total.webSearches += usage.webSearches;
  total.turns += usage.turns;
  total.tasks += 1;
  total.lastAt = Date.now();
  totals.set(name, total);
  persist();
  notify();

  return usage;
}

export function usageFor(name) {
  return { ...(totals.get(name) ?? emptyTotals()), since: startedAt };
}

/**
 * パイプラインの自動運転はチケット1件が複数コンテナへタスクを連鎖させるため、
 * コンテナ単位の集計だけでは「このチケットにどれだけ使ったか」が見えない。
 * recordResult が返す使用量をそのままチケット単位でも積み上げておく。
 */
export function recordTicketUsage(ticketId, usage) {
  if (!ticketId || !usage) return;
  const total = ticketTotals.get(ticketId) ?? emptyTotals();
  total.costUsd += usage.costUsd;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheCreationTokens += usage.cacheCreationTokens;
  total.webSearches += usage.webSearches;
  total.turns += usage.turns;
  total.tasks += 1;
  total.lastAt = Date.now();
  ticketTotals.set(ticketId, total);
  persist();
}

export function usageForTicket(ticketId) {
  return ticketTotals.get(ticketId) ?? emptyTotals();
}

/** 全コンテナの合計。ヘッダーの表示に使う。 */
export function fleetUsage() {
  const sum = emptyTotals();
  for (const total of totals.values()) {
    sum.costUsd += total.costUsd;
    sum.inputTokens += total.inputTokens;
    sum.outputTokens += total.outputTokens;
    sum.cacheReadTokens += total.cacheReadTokens;
    sum.cacheCreationTokens += total.cacheCreationTokens;
    sum.webSearches += total.webSearches;
    sum.turns += total.turns;
    sum.tasks += total.tasks;
    if (total.lastAt && (!sum.lastAt || total.lastAt > sum.lastAt)) sum.lastAt = total.lastAt;
  }
  return { ...sum, since: startedAt };
}

/**
 * name を省略すると全コンテナ分を消す。全消去のときだけ「since」の起点
 * （startedAt）も今に更新する（個別コンテナだけの消去で、他コンテナも参照する
 * 共通の起点を動かしてしまうと、他コンテナの「since」表示がおかしくなるため）。
 * レート上限はこちらが数えている値ではなく Anthropic 側の状態なので消さない。
 */
export function resetUsage(name) {
  if (name) {
    totals.delete(name);
  } else {
    totals.clear();
    startedAt = Date.now();
  }
  persist();
  notify();
}
