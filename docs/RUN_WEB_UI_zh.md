# NanoClaw 安装与启动说明

本文档说明如何从零开始安装依赖、构建项目、启动 NanoClaw 主服务，并直接通过内嵌 Web 控制台访问。

适用范围：
- 当前仓库已经改为 `Ollama-only`
- Web 控制台由 NanoClaw 主进程直接托管
- 推荐运行环境为 `Windows + WSL2 + Docker Desktop`，或原生 Linux

## 1. 前置条件

启动前请先确认以下条件成立：

- 已安装 `Node.js 20+`
- 已安装并启动 `Docker Desktop`
- Docker 可以正常构建和运行容器
- 已有可访问的 `Ollama HTTP API`
- 至少配置了一个消息渠道

说明：
- 当前代码里，NanoClaw 主进程即使开启了 Web 控制台，也仍然要求至少有一个已连接的消息渠道；如果没有渠道，进程会直接退出并报 `No channels connected`
- 目前仓库内已接入的渠道是 `Telegram` 和 `QQ(OneBot v11)`

## 2. 安装依赖

在项目根目录执行：

```bash
npm install
npm --prefix apps/web install
```

如果你后续重新克隆仓库，这是最基础的一步。

## 3. 准备环境变量

先复制示例文件：

```bash
cp .env.example .env
```

然后按你的环境修改 `.env`。

一个最小可运行示例如下：

```env
OLLAMA_HOST=http://host.docker.internal:11434
OLLAMA_MODEL=qwen3.5:latest
OLLAMA_TEMPERATURE=0.2

WEB_UI_ENABLED=true
WEB_UI_HOST=127.0.0.1
WEB_UI_PORT=3310
```

如果你的 Ollama 不是运行在宿主机，而是运行在 Docker 网络里的其他容器，请把 `OLLAMA_HOST` 改成对应的可访问地址。

## 4. 配置至少一个消息渠道

目前主进程要求至少有一个渠道成功连接，常见方案如下。

### Telegram

在 `.env` 里补充：

```env
TELEGRAM_BOT_TOKEN=你的_bot_token
```

如果你所在网络需要代理，也可以继续补：

```env
HTTP_PROXY=http://127.0.0.1:1080
HTTPS_PROXY=http://127.0.0.1:1080
NO_PROXY=localhost,127.0.0.1,host.docker.internal
```

### QQ

当前仓库接的是 `OneBot v11` 正向 WebSocket。需要你先准备好 NapCat 或其他 OneBot 服务端，然后在 `.env` 里补：

```env
QQ_ONEBOT_WS_URL=ws://127.0.0.1:3001
QQ_ONEBOT_ACCESS_TOKEN=你的token
```

## 5. 构建 NanoClaw 容器镜像

NanoClaw 的 agent 在容器里运行，所以首次启动前需要先构建镜像。

在项目根目录执行：

```bash
docker build -t nanoclaw-agent:latest container
```

如果你的 Docker 访问外网需要代理，请先在 Docker Desktop 里配置代理，再执行构建。

构建完成后，可以检查镜像是否存在：

```bash
docker images
```

确认输出里包含：

```text
nanoclaw-agent   latest
```

## 6. 构建项目

在项目根目录执行：

```bash
npm run build
```

这个命令会同时完成两件事：

- 编译 NanoClaw 主进程 TypeScript
- 构建 `apps/web` 前端静态资源

构建完成后，Web 资源会被主进程直接托管，不需要再单独启动 Vite。

## 7. 启动服务

在项目根目录执行：

```bash
npm start
```

如果想用开发模式运行主进程，可以执行：

```bash
npm run dev
```

但要注意：
- `npm run dev` 只影响主进程热加载
- Web 控制台的生产访问仍然以 `npm run build` 后的静态文件为准

## 8. 访问 Web 控制台

默认地址：

```text
http://127.0.0.1:3310
```

常用页面：

- `http://127.0.0.1:3310/`：仪表盘
- `http://127.0.0.1:3310/chat`：直接与 NanoClaw 对话
- `http://127.0.0.1:3310/inbox`：会话页
- `http://127.0.0.1:3310/channels`：渠道页
- `http://127.0.0.1:3310/tasks`：任务页
- `http://127.0.0.1:3310/settings`：运行时配置页

## 9. 启动后的自检

### 检查健康接口

浏览器或命令行访问：

```text
http://127.0.0.1:3310/api/health
```

返回 `200 OK` 就说明主进程和 Web API 已经起来了。

### 检查首页是否由主进程托管

访问：

```text
http://127.0.0.1:3310/
```

如果能打开控制台页面，就说明前端静态资源已经内嵌到 NanoClaw 主进程，不依赖 Vite dev server。

### 检查直聊能力

打开：

```text
http://127.0.0.1:3310/chat
```

输入一条简单消息，例如：

```text
只回复答案：8 + 9
```

如果返回正常，就说明：

- Web 直聊接口正常
- 主进程能拉起容器 agent
- 容器 agent 能访问配置好的 Ollama API

## 10. 可选：单独启动 Web 前端开发服务器

如果你正在开发前端页面，可以单独启动 Vite：

```bash
npm run web:dev
```

默认访问地址通常是：

```text
http://127.0.0.1:5173
```

但这只是前端开发模式。实际部署和日常使用，优先使用主进程托管的：

```text
http://127.0.0.1:3310
```

## 11. 常见问题

### 启动时报 `No channels connected`

原因：
- 当前没有任何渠道成功连接

处理方式：
- 检查 Telegram 或 QQ 的环境变量是否已配置
- 检查对应服务端是否真的可连通

### Web 页面能打开，但对话没有回复

优先检查：
- `OLLAMA_HOST` 是否可访问
- `OLLAMA_MODEL` 是否真实存在
- `nanoclaw-agent:latest` 镜像是否已经构建
- Docker 是否能正常启动容器

### `3310` 能打开 API，但页面样式丢失

优先检查：
- 是否已经执行过 `npm run build`
- `apps/web/dist` 是否已生成
- 主进程日志里是否有静态资源相关报错

## 12. 推荐启动顺序

每次重新部署时，建议按这个顺序执行：

```bash
npm install
npm --prefix apps/web install
docker build -t nanoclaw-agent:latest container
npm run build
npm start
```

如果依赖已经安装过，通常只需要：

```bash
docker build -t nanoclaw-agent:latest container
npm run build
npm start
```
