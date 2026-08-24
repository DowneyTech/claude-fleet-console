# claude-containers

Claude Code CLI をプロジェクトごとに独立した Docker コンテナ上で実行するための構成です。各コンテナは設定 (`~/.claude`) と作業ディレクトリを分離しつつ、ホストの `~/Project` を読み取り用の「vault」として共有します。

## 構成

- `Dockerfile` — `node:20-alpine` をベースに、Claude Code CLI (`@anthropic-ai/claude-code`) と `git` / `curl` / `bash` / `python3` / `go` などの開発ツールを導入したイメージ定義。非rootユーザー `claude` で実行されます。
- `docker-compose.yml` — プロジェクトごとのコンテナ定義（例: `claude-project-a`, `claude-project-b`）。

## 各コンテナのマウント内容

| マウント先 | 内容 |
| --- | --- |
| `/home/claude/.claude` | Claude Code の設定・認証情報を永続化する名前付きボリューム（プロジェクトごとに分離） |
| `/workspace` | そのプロジェクトの作業ディレクトリ（ホスト側の実フォルダをバインドマウント） |
| `/vault` | ホストの `~/Project` 全体を読み取り可能な形で共有（複数プロジェクトを横断参照したい場合用） |

## 必要要件

- Docker / Docker Compose
- `$HOME` 環境変数が展開できる環境（`docker compose` をホストのシェルから実行すること）

## 使い方

### イメージのビルド

```bash
docker compose build
```

### コンテナの起動（対話シェル）

```bash
docker compose run --rm claude-project-a
```

起動後、コンテナ内で `claude` コマンドを実行して Claude Code を使用します。

### バックグラウンド起動 + アタッチ

```bash
docker compose up -d claude-project-a
docker compose exec claude-project-a bash
```

## 新しいプロジェクトを追加する

`docker-compose.yml` に、既存の `claude-project-a` / `claude-project-b` と同様のブロックを追加します。

```yaml
  claude-project-c:
    build: .
    container_name: claude-project-c
    stdin_open: true
    tty: true
    working_dir: /workspace
    volumes:
      - claude-project-c-config:/home/claude/.claude
      - ${HOME}/project-c:/workspace
      - ${HOME}/Project:/vault

volumes:
  claude-project-c-config:
```

`${HOME}/project-c` の部分をホスト側の実際のプロジェクトパスに書き換えてください。

## 設定の永続化

各プロジェクトの Claude Code 設定・認証状態は名前付きボリューム（例: `claude-project-a-config`）に保存されるため、コンテナを再作成しても再ログインは不要です。設定をリセットしたい場合はボリュームを削除してください。

```bash
docker volume rm claude-project-a-config
```
