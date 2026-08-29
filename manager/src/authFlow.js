import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Docker from 'dockerode';
import { container, execCapture } from './docker.js';

/**
 * `claude auth login` をコンテナ内で走らせ、OAuth の URL だけを UI に渡す。
 *
 * セキュリティ上の約束:
 *  - 生のターミナル出力はブラウザへ一切送らない。認証後の出力にトークンが混ざりうるため、
 *    外に出すのは解析済みの {phase, url, error} だけに限定する。
 *  - 利用者が貼り付けた認証コードは stdin に書いた時点で捨てる。保存もログ出力もしない。
 *  - 成否は端末出力からではなく `claude auth status` の再取得で判定する。
 *
 * CLI の実挙動（実測）:
 *  - 不正なコードでは "Invalid code" と出すだけでプロセスは終了せず、再入力を受け付ける。
 *    よって完了検知を stream の終了に頼ってはいけない。
 *  - exec のストリームは Tty:true でもフレームヘッダ付きで多重化される。
 */

const docker = new Docker();

const logins = new Map(); // コンテナ名 → ログインセッション
const statusCache = new Map(); // コンテナ名 → { at, value }

const STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_SEC = 600;
const VERIFY_TIMEOUT_MS = 90_000;
const VERIFY_POLL_MS = 1500;
const TERMINAL_PHASES = ['success', 'error', 'cancelled'];

// ESC は \x1b と明示する（生の ESC バイトを埋めると grep やレビューで読めない）。
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const AUTHORIZE_URL = /(https:\/\/\S+\/oauth\/authorize\?\S+)/;
const INVALID_CODE = /Invalid code/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripAnsi(text) {
  // 制御文字が残ると URL や JSON の解析を壊すので、ESC 単体も落とす。
  return text.replace(ANSI, '').replace(/\x1b/g, '');
}

/** UI へ返してよい形。stream / buffer など内部状態は決して含めない。 */
export function loginView(name) {
  const session = logins.get(name);
  if (!session) return { phase: 'idle' };
  return {
    phase: session.phase,
    url: session.url ?? null,
    startedAt: session.startedAt,
    error: session.error ?? null,
  };
}

export function isLoggingIn(name) {
  const session = logins.get(name);
  return Boolean(session) && !TERMINAL_PHASES.includes(session.phase);
}

export function invalidateStatus(name) {
  statusCache.delete(name);
}

/** `claude auth status` の JSON。既知のフィールドだけを通す。 */
export async function authStatus(name, { force = false } = {}) {
  const cached = statusCache.get(name);
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.value;
  }

  let value = { loggedIn: false, authMethod: 'unknown', apiProvider: null };
  try {
    // 未ログインだと終了コードは 1 になるが、JSON 自体は正しく出る。
    // よって終了コードではなく、パースできたかどうかで判断する。
    const { stdout } = await execCapture(name, ['claude', 'auth', 'status']);
    const parsed = JSON.parse(stripAnsi(stdout).trim());
    value = {
      loggedIn: Boolean(parsed.loggedIn),
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'unknown',
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : null,
    };
  } catch {
    // 停止中・未作成のコンテナ、または想定外の出力。未ログイン扱いで返す。
  }

  statusCache.set(name, { at: Date.now(), value });
  return value;
}

/**
 * コンテナ内に残っているログインプロセスを確実に落とす。
 * stdin を閉じるだけでは `claude auth login` は終了しないため、
 * これを省くとキャンセル後に二重起動しうる。
 *
 * パターンをシェル変数から組み立てているのは、pkill 自身のコマンドラインに
 * 検索文字列がそのまま現れて自分を殺してしまうのを避けるため
 * （busybox の pkill は `[c]laude` のような文字クラスを解釈しない）。
 */
async function killLoginProcess(name) {
  try {
    await execCapture(name, [
      'sh',
      '-c',
      'P="claude auth"; pkill -TERM -f "$P login"; sleep 1; pkill -KILL -f "$P login" 2>/dev/null; true',
    ]);
  } catch {
    /* 対象がいない場合や停止中のコンテナ。無視してよい。 */
  }
}

function closeStream(session) {
  try {
    session.stream?.end();
  } catch {
    /* 既に閉じている */
  }
  session.stream = null;
  session.buffer = '';
}

function settle(session, phase, error) {
  session.phase = phase;
  session.error = error ?? null;
  // 完了・失敗・キャンセル後に古い URL を見せない。
  if (phase !== 'success') session.url = null;
  closeStream(session);
}

/** ログインフローを開始し、OAuth URL が現れるまで待つ。 */
export async function startLogin(cfg) {
  if (isLoggingIn(cfg.name)) {
    return loginView(cfg.name);
  }

  // await の前に枠を確保する。そうしないと同時リクエストが両方ガードを抜け、
  // 二つ目の logins.set が一つ目のセッション（開いたままの socket）を捨ててしまう。
  const session = {
    container: cfg.name,
    phase: 'starting',
    url: null,
    error: null,
    startedAt: Date.now(),
    stream: null,
    buffer: '',
  };
  logins.set(cfg.name, session);

  // 前回のキャンセル分などが残っていると二重起動になるため、先に掃除する。
  await killLoginProcess(cfg.name);

  // timeout でラップして、放置されたフローが必ず片付くようにする。
  const exec = await container(cfg.name).exec({
    Cmd: ['sh', '-c', `timeout ${LOGIN_TIMEOUT_SEC} claude auth login --claudeai`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });

  const stream = await exec.start({ hijack: true, stdin: true });

  // 枠は上で確保済み。ここでは実際のストリームを差し込むだけ。
  session.stream = stream;

  const onText = (text) => {
    // URL 検出と失敗判定のためだけに保持する。UI には決して出さず、上限も設ける。
    session.buffer = (session.buffer + stripAnsi(text)).slice(-8000);

    if (!session.url) {
      const match = session.buffer.match(AUTHORIZE_URL);
      if (match) {
        session.url = match[1];
        if (session.phase === 'starting') session.phase = 'awaiting_code';
      }
    }

    // 不正コード時、CLI は終了せずその場で再入力を待つ。URL は有効なままなので、
    // 同じセッションで貼り直せるよう awaiting_code に戻す。
    if (session.phase === 'verifying' && INVALID_CODE.test(session.buffer)) {
      session.phase = 'awaiting_code';
      session.error = 'コードが正しくありません。コード全体がコピーされているか確認して、貼り直してください。';
      session.buffer = '';
    }
  };

  // Tty:true でもフレームヘッダが付くため、demux させて素のテキストを得る（実測）。
  // chunk 単位の toString はマルチバイト文字を分割地点で壊すので decoder を使う。
  const decoder = new StringDecoder('utf8');
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const text = decoder.write(chunk);
      if (text) onText(text);
      cb();
    },
  });
  docker.modem.demuxStream(stream, sink, sink);

  stream.on('error', (err) => {
    if (!TERMINAL_PHASES.includes(session.phase)) {
      settle(session, 'error', err.message);
    }
  });

  stream.on('end', () => {
    // 成功判定は watchVerification 側が auth status で行う。ここは異常終了の受け皿。
    if (!TERMINAL_PHASES.includes(session.phase) && session.phase !== 'verifying') {
      settle(session, 'error', 'ログインプロセスが終了しました。もう一度お試しください。');
    }
  });

  // URL が出るまで少し待つ。
  const deadline = Date.now() + 20000;
  while (!session.url && Date.now() < deadline && session.phase === 'starting') {
    await sleep(200);
  }

  if (!session.url && session.phase === 'starting') {
    settle(session, 'error', '認証 URL を取得できませんでした。');
    await killLoginProcess(cfg.name);
  }

  return loginView(cfg.name);
}

/**
 * コード送信後の成否を `claude auth status` の変化で判定する。
 * 不正コードだとプロセスが終了しないため、stream の終了は当てにできない。
 */
async function watchVerification(session) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(VERIFY_POLL_MS);

    // "Invalid code" 検出やキャンセルで既に別フェーズへ移っていたら降りる。
    if (session.phase !== 'verifying') return;

    const status = await authStatus(session.container, { force: true });
    if (status.loggedIn) {
      settle(session, 'success');
      await killLoginProcess(session.container);
      return;
    }
  }

  if (session.phase === 'verifying') {
    // URL は生きているので、貼り直せるよう awaiting_code に戻す。
    session.phase = 'awaiting_code';
    session.error = '確認がタイムアウトしました。コードを貼り直してください。';
  }
}

/**
 * 利用者が貼り付けた認証コードを stdin へ渡す。
 * code はここで書き込むだけで、保持も記録もしない。
 */
export function submitCode(name, code) {
  const session = logins.get(name);
  if (!session || session.phase !== 'awaiting_code' || !session.stream) {
    const err = new Error('コード入力待ちのログインセッションがありません');
    err.status = 409;
    throw err;
  }

  session.phase = 'verifying';
  session.error = null;
  // 前回の "Invalid code" が残っていると即座に誤検知するので消す。
  session.buffer = '';
  // PTY の Enter は CR。
  session.stream.write(`${code}\r`);

  // await しない非同期処理なので、握りつぶさずに必ず捕まえる
  // （未処理の rejection は Node のプロセスごと落とす）。
  watchVerification(session).catch((err) => {
    settle(session, 'error', `確認中にエラーが発生しました: ${err.message}`);
  });

  return loginView(name);
}

export async function cancelLogin(name) {
  const session = logins.get(name);
  if (session && isLoggingIn(name)) {
    settle(session, 'cancelled');
  }
  await killLoginProcess(name);
  return loginView(name);
}

export async function logout(name) {
  // 進行中のセッションを黙って捨てると、開いたままの socket が漏れる。
  const session = logins.get(name);
  if (session && isLoggingIn(name)) settle(session, 'cancelled');

  await killLoginProcess(name);
  const { exitCode, stderr } = await execCapture(name, ['claude', 'auth', 'logout']);
  invalidateStatus(name);
  logins.delete(name);
  if (exitCode !== 0) {
    const err = new Error(stripAnsi(stderr).trim() || 'ログアウトに失敗しました');
    err.status = 500;
    throw err;
  }
  return authStatus(name, { force: true });
}
