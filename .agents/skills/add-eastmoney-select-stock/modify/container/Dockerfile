# NanoClaw Agent Container
# Runs a local Ollama-backed agent in an isolated Linux container

FROM node:22-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g agent-browser

WORKDIR /app

COPY agent-runner/package.json ./
RUN npm install

COPY agent-runner/ ./
RUN npm run build

COPY skills/eastmoney-select-stock/eastmoney-select-stock /usr/local/bin/eastmoney-select-stock
RUN chmod +x /usr/local/bin/eastmoney-select-stock

RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace && chmod 777 /home/node

USER node
WORKDIR /workspace/group
ENTRYPOINT ["/app/entrypoint.sh"]
