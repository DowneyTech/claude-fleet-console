import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Docker from 'dockerode';

// 既定で /var/run/docker.sock を使う（compose でマウント済み）。
const docker = new Docker();

export function container(name) {
  return docker.getContainer(name);
}

/** コンテナが存在しない場合は null を返す（レジストリにあるが未作成、というケース）。 */
export async function inspect(name) {
  try {
    return await container(name).inspect();
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function lifecycle(name, action) {
  const c = container(name);
  if (action === 'start') return c.start();
  if (action === 'stop') return c.stop({ t: 5 });
  if (action === 'restart') return c.restart({ t: 5 });
  throw new Error(`unknown action: ${action}`);
}

// 状態取得系の exec は短時間で返るはず。返らない場合は諦める。
// 上限が無いと、1 本の exec がハングしただけで呼び出し元のループが永久に止まる。
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

function collector(chunks) {
  return new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
}

/**
 * 終了コードを確定させる。stream の終了直後は exec がまだ Running 扱いで
 * ExitCode が null のことがあり、それを 0（成功）と読むと失敗を握り潰す。
 * 確定しなければ null を返し、呼び出し側に「不明」として扱わせる。
 */
async function finalExitCode(exec) {
  for (let i = 0; i < 20; i += 1) {
    const info = await exec.inspect();
    if (!info.Running) return info.ExitCode ?? null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** ストリームの終了を待つ。timeoutMs を過ぎたらストリームを壊して失敗させる。 */
function waitForStream(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      stream.destroy();
      finish(new Error(`exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    stream.on('end', () => finish());
    stream.on('close', () => finish());
    stream.on('error', (err) => finish(err));
  });
}

/**
 * コンテナ内でコマンドを実行し、終了まで待って全出力を返す。
 *
 * Tty:false の exec は stdout/stderr が 1 本のストリームに多重化されているため、
 * demuxStream で分離しないと出力が壊れる。
 */
export async function execCapture(name, cmd, { workingDir, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS } = {}) {
  const exec = await container(name).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: workingDir,
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  const outChunks = [];
  const errChunks = [];
  docker.modem.demuxStream(stream, collector(outChunks), collector(errChunks));

  await waitForStream(stream, timeoutMs);

  return {
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
    exitCode: await finalExitCode(exec),
  };
}

/**
 * コンテナ内でコマンドを実行し、stdout を 1 行ずつコールバックへ流す。
 * 解決値は終了コード。
 */
export async function execLines(
  name,
  cmd,
  // タスクは長時間動きうるので既定の上限は緩め。それでも無制限にはしない
  // （ハングしたタスクはそのコンテナを永久に busy にしてしまう）。
  { workingDir, onStdoutLine, onStderr, timeoutMs = 30 * 60_000 } = {},
) {
  const exec = await container(name).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: workingDir,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  // チャンク境界でマルチバイト文字が分割されるため、chunk 単位の toString は
  // 日本語などを U+FFFD に壊す。StringDecoder に持ち越させる。
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');

  let buffered = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      buffered += outDecoder.write(chunk);
      let idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (line.trim()) onStdoutLine?.(line);
      }
      cb();
    },
  });

  const stderr = new Writable({
    write(chunk, _enc, cb) {
      const text = errDecoder.write(chunk);
      if (text) onStderr?.(text);
      cb();
    },
  });

  docker.modem.demuxStream(stream, stdout, stderr);

  await waitForStream(stream, timeoutMs);

  // 改行で終わらなかった最後の 1 行を取りこぼさない。
  buffered += outDecoder.end();
  if (buffered.trim()) onStdoutLine?.(buffered);

  return finalExitCode(exec);
}
