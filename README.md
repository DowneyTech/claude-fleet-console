# claude-containers

Claude Code CLI をプロジェクトごとに独立した Docker コンテナ上で実行し、その稼働状況をブラウザから可視化・操作するための構成です。各コンテナは設定 (`~/.claude`) と作業ディレクトリを分離しつつ、ホストの `~/Project` を読み取り用の「vault」として共有します。

## 構成

- `Dockerfile` — `node:20-alpine` をベースに、Claude Code CLI (`@anthropic-ai/claude-code`) と `git` / `curl` / `bash` / `python3` / `go` などの開発ツールを導入したイメージ定義。非rootユーザー `claude` で実行されます。
- `docker-compose.yml` — プロジェクトごとのコンテナ定義（例: `claude-project-a`, `claude-project-b`）と、管理UI の `manager` サービス。
- `manager/` — 管理ダッシュボード（Node.js + Express）。`http://127.0.0.1:4590` で待ち受けます。

## アーキテクチャ

```
ブラウザ ──5秒ポーリング + SSE──▶ manager ──/var/run/docker.sock──▶ claude-project-*
```

manager は各コンテナへ **`docker exec` 経由でのみ** アクセスします。Claude Code のセッション記録 (`~/.claude/projects/-workspace/*.jsonl`) は `600`（所有者のみ読み取り）で作られるため、名前付きボリュームを manager 側にマウントしても UID が一致せず読めません。稼働状況の取得・履歴の閲覧・タスクの投入をすべて `exec` に統一することで、manager に必要な追加マウントは `docker.sock` ひとつだけになります。

**リアルタイム性は3段階です。**

1. タスク実行中はそのコンテナの `stream-json` 出力を SSE (`/task/stream`) で逐次中継します（真のライブ）。
2. ヘッダーのコスト・トークン集計とレート上限は、専用の SSE (`/api/containers/usage/stream`) で配信します。コストはタスク完了時の `result` イベントで、レート上限は Anthropic のアカウント使用状況 API を manager が定期ポーリング（+ タスク完了時に前倒し取得）した結果で、それぞれ値が変わった直後に manager 内部で push され、5 秒ポーリングを待ちません。
3. それ以外の稼働状況（状態・最終活動時刻・認証など）は 5 秒間隔のポーリングによるスナップショットです。

### 画面が更新されるタイミング

| 経路 | 間隔 | 更新される内容 |
| --- | --- | --- |
| SSE (`/task/stream`) | 届き次第（真のライブ） | 実行中タスクのログ行 |
| SSE (`/usage/stream`) | 届き次第（真のライブ） | ヘッダーのコスト・トークン・レート上限 |
| ポーリング (`GET /api/containers`) | 5 秒 | 状態・最終活動時刻・認証・カードのレート上限（フォールバック） |
| 認証ダイアログ | 2 秒（進行中のみ） | ログインの進行状況 |
| 「更新」ボタン / 各種操作の直後 | 即時 | 上記ポーリングと同じ内容 |

即時のポーリングは、起動・停止・再起動、タスク投入、タスク完了（SSE の `closed`）、認証ダイアログを閉じたときにも走ります。

`/usage/stream` は接続直後に現在値を 1 回送り、以後は値が変わるたびに push します。ブラウザは 1 本だけ張りっぱなしにして、切断されても自動再接続します（再接続直後にもう一度現在値が届くので取りこぼしません）。5 秒ポーリング側でも同じ値を描画しており、SSE が瞬断した間の保険として機能します。

コストの値そのものは、CLI がタスクの最後に流す `result` イベントからしか取れません（タスク実行中に少しずつ増えていくわけではなく、完了した瞬間にまとまって確定します）。`assistant` イベントにもターンごとの usage は乗りますが、実測すると同一 API 呼び出しの重複や未確定の途中経過値を含み、積算に使うと実態と異なる数字になるため採用していません。レート上限は Anthropic のアカウント使用状況 API から直接取得しているため、タスクの実行有無に関係なく常に最新値が分かります（詳細は後述）。「リアルタイムに近い」というのは、値が確定した瞬間から画面に出るまでの遅延（旧: 最大 5 秒 → 現在: 通常 1 秒未満）についての話です。「あと 4 時間 47 分」のような残り時間はポーリングのたびに計算し直しています。

## 各コンテナのマウント内容

| マウント先 | 内容 |
| --- | --- |
| `/home/claude/.claude` | Claude Code の設定・認証情報を永続化する名前付きボリューム（プロジェクトごとに分離） |

> `Dockerfile` は `/home/claude/.claude` を **イメージ内に `claude` 所有で作成** しています。これが無いと Docker が名前付きボリュームのマウント先を root 所有で作り、`claude` ユーザーが書き込めなくなります。その状態では CLI がエラーを出さないまま認証情報もセッション履歴も保存されず、ログインが延々と完了しません。ダッシュボードはこの状態を検出して赤い警告を出します。
| `/workspace` | そのプロジェクトの作業ディレクトリ（ホスト側の実フォルダをバインドマウント） |
| `/vault` | ホストの `~/Project` 全体を **読み取り専用** (`:ro`) で共有（複数プロジェクトを横断参照したい場合用） |

## 必要要件

- Docker / Docker Compose
- `$HOME` 環境変数が展開できる環境（`docker compose` をホストのシェルから実行すること）
- バインドマウント元のディレクトリ（`~/project-a`, `~/project-b`）が存在すること

## 使い方

### ビルドと起動

```bash
docker compose build
docker compose up -d
```

各 Claude コンテナは `command: ["tail", "-f", "/dev/null"]` で常駐します。manager が `docker exec` で操作するには、コンテナが起動したままである必要があるためです（`CMD ["bash"]` のままだと非対話 stdin が即 EOF になり、`up -d` では起動直後に終了してしまいます）。

### ダッシュボード

```
http://127.0.0.1:4590
```

コンテナごとのカードから、状態の確認・起動 / 停止 / 再起動・プロンプトの投入・セッション履歴の閲覧ができます。

### 初回ログイン（コンテナごとに1回）

Claude Code の認証はコンテナごとの名前付きボリュームに保存されるため、各コンテナで一度だけログインが必要です。ダッシュボードの「認証」ボタンから行えます。

1. カードの「認証」→「ログインを開始」を押すと、コンテナ内で `claude auth login` が起動します
2. 表示された認証 URL を開き、自分の Anthropic アカウントで認証します
3. 表示されたコードをダッシュボードの入力欄に貼り付けます

コードが正しくない場合はその場でエラーが表示され、同じ URL のまま貼り直せます（CLI 側は不正コードでは終了せず再入力を待つため）。

コードはコンテナ内の CLI の標準入力へ渡されるだけで、manager は保存もログ出力もしません。認証の成否は端末出力ではなく `claude auth status` の再取得で判定しています。ブラウザに返すのは解析済みの `{phase, url, error}` のみで、生の端末出力は一切送りません（認証後の出力にトークンが混ざりうるため）。

CLI から行う場合は次のとおりです。

```bash
docker compose exec claude-project-a claude auth login
```

### 対話シェルで使う

```bash
docker compose exec claude-project-a bash
```

> 従来の `docker compose run --rm claude-project-a` は、その場限りのコンテナを作るため manager の管理対象になりません。`exec` を使ってください。

## 管理UI の API

| Method | Path | 概要 |
| --- | --- | --- |
| GET | `/api/containers` | 全コンテナの状態・最終活動時刻・実行中タスク・使用量・レート上限（+全体の合計） |
| GET | `/api/containers/usage/stream` | ヘッダー用のコスト・トークン・レート上限の SSE（変更のたびに push） |
| POST | `/api/containers/:name/start` \| `/stop` \| `/restart` | ライフサイクル操作 |
| POST | `/api/containers/:name/tasks` | タスク投入（`{ prompt, newSession, model }`）。busy なら自動でキューに積み `{ queued: true, item }` を返す |
| DELETE | `/api/containers/:name/task` | 実行中タスクの停止 |
| GET | `/api/containers/:name/task/stream` | 実行中タスクの SSE（既存イベントを再生してから購読） |
| GET | `/api/containers/:name/tasks/queue` | 実行待ちタスクの一覧 |
| DELETE | `/api/containers/:name/tasks/queue/:id` | 実行待ちタスクをキューから取り消し |
| GET | `/api/containers/:name/sessions` | セッション一覧 |
| GET | `/api/containers/:name/sessions/:id` | セッションの内容 |
| POST | `/api/containers/:name/sessions/:id/resume` | 次のタスク投入で resume するセッションを指定した ID に切り替え |
| GET | `/api/containers/:name/auth` | 認証状態（`claude auth status`）とログイン進行状況 |
| POST | `/api/containers/:name/auth/login` | ログイン開始（認証 URL を返す） |
| POST | `/api/containers/:name/auth/code` | 認証コードを CLI の stdin へ渡す |
| DELETE | `/api/containers/:name/auth/login` | ログイン中断（プロセスも終了させる） |
| POST | `/api/containers/:name/auth/logout` | ログアウト |
| DELETE | `/api/containers/usage` | 全コンテナの累計使用量をリセット |
| DELETE | `/api/containers/:name/usage` | そのコンテナの累計使用量をリセット |

### 使用量の表示（トークン・コスト）

**ヘッダーにのみ**表示します。カード（各プロジェクト）にはトークン使用量を出しません。全コンテナ合計の金額・タスク数・入出力トークン・キャッシュ読取量を出しており（カーソルを乗せると正確な値と内訳が出ます）、コンテナ別の値が必要な場合は `GET /api/containers` の各要素の `usage` を見てください。

金額は manager が単価を掛けて計算したものではなく、CLI が返す `total_cost_usd` をそのまま合計しています（単価表を manager 側に持つと必ず古くなるため）。取得元は `result` イベント（タスク完了時に一度だけ来る確定値）のみで、`assistant` イベントのターンごとの usage は使っていません（同一呼び出しの重複や未確定値を含み、積算すると実態と異なる数字になるため）。

> 累計はメモリ上にのみ保持しており、**manager コンテナを再作成するとリセットされます**。正式な請求額は Anthropic のコンソールを参照してください。
>
> 「累計をリセット」はコストとトークンの集計だけを消します。レート上限は manager が数えている値ではなく Anthropic 側の状態なので、リセットの対象外です。

### レート上限（5時間 / 週）

カード上部とヘッダーの両方に出します。ヘッダーは全コンテナのうち**一番きつい値**を表示します（別アカウントで運用している場合に、余裕がある方を見て安心しないため）。

上限の値は、Claude Code の「使用状況」表示が参照しているのと同じアカウント単位のエンドポイント `https://api.anthropic.com/api/oauth/usage` から取得しています（`manager/src/remoteUsage.js`）。コンテナ内の `~/.claude/.credentials.json` から現在の access token を読み、`Authorization: Bearer <token>` で直接呼び出します。

- **30 秒間隔でポーリング**し、加えて**タスク完了直後にも前倒しで取得**します（タスク実行が利用率を動かす主な契機のため）。
- ログインしてさえいれば、**タスクを一度も実行していなくても**現在の利用率が分かります。旧実装（CLI が `stream-json` に流す `rate_limit_event` を拾う方式）は上限に近い窓しか通知されず、タスクを実行するまで「未取得」のままでしたが、この方式ではその制約がありません。
- token は毎回コンテナから読み直すため、CLI が裏で自動更新したトークンにもそのまま追従します。manager 側でトークンのリフレッシュや保存は行いません。
- レスポンスが失敗した場合（トークン期限切れ直後の一瞬など）は前回値を保持し、次のポーリングに委ねます。

`claude auth status` のようにレート上限を直接問い合わせる CLI コマンドは無いため、この API 呼び出し以外に取得手段はありません。

上限はアカウント単位で、コンテナ単位ではありません。同じアカウントでログインしたコンテナは同じ枠を食い合います。

### Markdown の表示

Claude の応答（実行ログの本文と履歴のテキスト）は Markdown として整形表示します。見出し・リスト（入れ子・番号付き）・表・コードブロック・引用・強調・リンクに対応しています。

整形は `manager/public/markdown.js` の自前実装です。外部ライブラリを使わないのは、manager が CDN に到達できない環境でも動くようにするためで、`innerHTML` を一切使わず DOM を組み立てているため、応答に HTML やスクリプトが混ざっていても文字として表示されるだけです。リンクは `http`/`https` のみを実リンクにし、それ以外のスキームは元の記法のまま文字として出します。

### セッションの扱い

タスク投入時、使用するセッション ID は次の順で決まります。

1. manager がメモリ上に保持している ID があれば `--resume` で継続
2. 無ければコンテナ内の最新 `*.jsonl`（手動対話したものを含む）を探索して `--resume`
3. それも無ければ UUID を新規発行して `--session-id` で開始

UI の「新しいセッションで開始」にチェックを入れると、常に 3 になります。

①のメモリ上の ID は、履歴ダイアログで任意のセッションの「ここから再開」を押すことでも書き換えられます。最新でない過去のセッションから続きを始めたい場合に使います（実行中のタスクがある間は競合を避けるため切り替えを拒否します）。この ID もメモリ上にのみ保持しているため、manager コンテナを再作成するとリセットされ、次回投入時は②の探索に戻ります。

### モデルの切り替え

タスクは既定では `--model` を付けずに実行し、アカウント（CLI）側のデフォルトモデルに従います。

- コンテナごとの既定値は `containers.config.json` の `model`（`opus` / `sonnet` / `haiku` などの CLI エイリアス、またはフルの ID）で設定でき、設定UI の「既定モデル」からも変更できます。
- タスク投入フォームのセレクトで、その 1 回だけ既定値を上書きできます（`POST .../tasks` の `model`）。
- どちらも空なら `--model` を省略し、CLI 側のデフォルトに委ねます。

### タスクの停止・キュー投入

- **停止**: 実行ログ右上の「停止」から、実行中のタスクを途中で止められます。同じコンテナでは `claude -p` プロセスは常に高々 1 個という前提でコマンドライン先頭一致により対象を絞って `SIGTERM` を送ります。`claude` が起動した個々のツール実行（子プロセス）までは追わない既知の制約があります。
- **キュー投入**: busy なコンテナへ投入すると、拒否されずに自動でキューへ積まれます（「送信」ボタンが「キューに追加」に変わります）。現在のタスクが完了・失敗・キャンセルのいずれで終わっても、直後にキューの先頭が自動で起動します。キューは各コンテナ・各アイテムとも `newSession` / `model` を個別に保持し、カード上の一覧から個別に取り消せます。キューはメモリ上にのみ保持しており、manager コンテナを再作成すると失われます。

## セキュリティ上の注意

このダッシュボードは**認証機構を持ちません**。以下を理解した上で利用してください。

- **`docker.sock` はホストの root 相当の権限です。** manager コンテナはホストの Docker を自由に操作できます。ポートは `127.0.0.1:4590` に限定して公開しており、これを `0.0.0.0` に変更してはいけません。外部サイトが名前解決を `127.0.0.1` に向ける DNS リバインディング対策として、`Host` ヘッダがループバック以外のリクエストは 403 で拒否しています。
- **ログイン機能は認証コードを扱います。** manager は認証コードを stdin へ渡すだけで保存しませんが、この API 自体に認証はありません。ループバック限定の公開を維持してください。
- **タスクは `--permission-mode bypassPermissions` で実行されます。** UI からプロンプトを投げた瞬間、確認なしにコンテナ内でコマンド実行・ファイル編集が行われます。コンテナが唯一の隔離境界です。ツールを制限したい場合は `manager/containers.config.json` の各エントリに `allowedTools` を指定してください。

  ```json
  { "name": "claude-project-a", "allowedTools": ["Read", "Grep", "Glob"] }
  ```

  `permissionMode` を `default` にすると確認プロンプトで停止するため、非対話実行では完走しません。
- **`/vault` は全コンテナで共有されています。** あるコンテナで実行された処理が、ホストの `~/Project` 配下すべてを読み取れます。無人実行ではこのリスクが顕在化しやすくなります。`:ro` を付けているため書き込みは防がれますが、**この `:ro` を外してはいけません**。外すと UI から投げたプロンプト一つでホストの `~/Project` 配下が破壊されうる状態になります（`/workspace` は書き込み可能なので、作業自体には影響しません）。
- **UI 操作中に同じコンテナへ手動で介入しないでください。** manager が `--resume` で書き込み中のセッションを `docker compose exec claude-project-a claude` で開くと競合する可能性があります。
- **manager はレート上限の取得のため、各コンテナの OAuth access token を読み、Anthropic の API (`api.anthropic.com`) へ直接送信します。** 送信先は token が本来使われる正規のエンドポイントのみで、他所には送りません。token 自体はコンテナ内の `.credentials.json` から都度読み直すだけで、manager 側での保存・ログ出力・リフレッシュは行いません。

## 新しいプロジェクトを追加する

1. `docker-compose.yml` にサービスを追加します。

```yaml
  claude-project-c:
    build: .
    container_name: claude-project-c
    stdin_open: true
    tty: true
    working_dir: /workspace
    command: ["tail", "-f", "/dev/null"]
    restart: unless-stopped
    volumes:
      - claude-project-c-config:/home/claude/.claude
      - ${HOME}/project-c:/workspace
      - ${HOME}/Project:/vault

volumes:
  claude-project-c-config:
```

2. `manager/containers.config.json` にも同じ名前で登録します（管理UI に出すため）。

```json
{ "name": "claude-project-c", "displayName": "Project C", "workspacePath": "/workspace" }
```

3. `docker compose up -d --build` で反映します。

`${HOME}/project-c` の部分はホスト側の実際のプロジェクトパスに書き換えてください。

## 設定の永続化

各プロジェクトの Claude Code 設定・認証状態は名前付きボリューム（例: `claude-project-a-config`）に保存されるため、コンテナを再作成しても再ログインは不要です。設定をリセットしたい場合はボリュームを削除してください。

```bash
docker compose down
docker volume rm claude-containers_claude-project-a-config
docker compose up -d
```

`Dockerfile` の所有者設定を変更した場合も、既存のボリュームには反映されないため、同じ手順で作り直す必要があります。
