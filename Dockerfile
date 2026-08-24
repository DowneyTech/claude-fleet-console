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
USER claude
WORKDIR /workspace

CMD ["bash"]
