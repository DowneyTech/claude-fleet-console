import { listContainerConfigs } from './config.js';
import { execCapture } from './docker.js';
import { setRateLimits } from './usageStore.js';

/**
 * Claude Code CLI が「使用状況」ダッシュボードの表示に使っているのと同じ
 * アカウント単位のエンドポイント。ログインしてさえいれば、タスクを一切
 * 実行していなくても現在の利用率を取れる。CLI の `rate_limit_event`
 * （ログにたまたま乗った、上限に近い窓しか分からない）より正確で、かつ
 * 実行中のタスクに依存せずポーリングできる。
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = '/home/claude/.claude/.credentials.json';

const POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

// レスポンスにはこの他にも内部コードネームの実験的な枠（例: nimbus_quill,
// tangelo）が null や 0 のまま並ぶ。ユーザー向けの意味を持たないため、
// ラベルを持つ既知の窓だけを拾う。
const SUPPORTED_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_oauth_apps'];

/** コンテナ内の認証情報から現在の access token を読む。都度読み直すことで、
 *  CLI 自身が裏でリフレッシュしたトークンにも自然に追従する。 */
async function readAccessToken(name) {
  try {
    const { stdout, exitCode } = await execCapture(name, ['cat', CREDENTIALS_PATH]);
    if (exitCode !== 0) return null;
    const token = JSON.parse(stdout)?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null; // 未ログイン、停止中のコンテナ、壊れた JSON など。
  }
}

/** 1 つの窓（five_hour など）を、UI がこれまで扱ってきた形へ正規化する。 */
function normalizeWindow(type, value, overageInUse) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.utilization)) return null;
  return {
    type,
    // API はパーセント（0-100）で返す。UI 側は比率（0-1）を前提にしている。
    utilization: value.utilization / 100,
    resetsAt: typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : null,
    // ロック中（上限に達し拒否される状態）だけ理由が入る。それ以外は null。
    status: typeof value.locked_reason === 'string' && value.locked_reason ? value.locked_reason : null,
    isUsingOverage: overageInUse,
    at: Date.now(),
  };
}

/** 1 コンテナぶん取得して usageStore に反映する。失敗しても例外は投げない。 */
export async function pollContainer(name) {
  const token = await readAccessToken(name);
  if (!token) {
    setRateLimits(name, {});
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
    });
    // 401 などは前回値を残したまま様子を見る（トークン更新直後の一瞬の
    // ずれなどで消してしまうと、実際には正常な状態を「未取得」に戻してしまう）。
    if (!res.ok) return;

    const data = await res.json();
    // 実際に追加クレジットを消費している場合のみ「追加利用中」として扱う。
    // enabled は「使える設定になっている」だけで、消費中とは限らない。
    const overageInUse = Number(data?.extra_usage?.used_credits) > 0;

    const limits = {};
    for (const type of SUPPORTED_WINDOWS) {
      const entry = normalizeWindow(type, data?.[type], overageInUse);
      if (entry) limits[type] = entry;
    }
    setRateLimits(name, limits);
  } catch {
    // ネットワークエラー・タイムアウト。前回値を残し、次のポーリングに委ねる。
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 全コンテナぶん、起動時に一度取得してからポーリングを開始する。
 * 対象は毎回 listContainerConfigs() から読み直す。設定UI から
 * プロジェクトを追加した場合も、manager を再起動せず追随できる。
 */
export function startPolling() {
  const tick = () => {
    for (const cfg of listContainerConfigs()) pollContainer(cfg.name);
  };
  tick();
  setInterval(tick, POLL_MS);
}
