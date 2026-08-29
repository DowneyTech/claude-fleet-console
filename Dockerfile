FROM node:20-alpine

RUN apk add --no-cache \
        git \
        ca-certificates \
        curl \
        bash \
        python3 \
        py3-pip \
        go

RUN npm install -g @anthropic-ai/claude-code

RUN addgroup -S claude && adduser -S claude -G claude -s /bin/bash

# 設定ディレクトリをイメージ内に claude 所有で作っておく。
# これが無いと、名前付きボリュームのマウント先を Docker が root 所有で作ってしまい、
# claude ユーザーが書き込めず、認証情報もセッション履歴も保存できなくなる。
RUN mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

USER claude
WORKDIR /workspace

CMD ["bash"]
