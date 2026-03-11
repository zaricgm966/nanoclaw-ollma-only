# 设计：增加 React 控制台

## 概览

新的 UI 作为当前 NanoClaw 运行时之上的一个可选层，而不是替代现有系统。现有 Node.js 进程仍然负责渠道、SQLite、任务调度、容器执行和消息路由。我们在这个进程内增加一个轻量 HTTP 服务，再由 React 应用消费这些接口。

## 架构设计

### 后端

在 `src/web/` 下增加一个小型 Web 服务模块，并由现有 NanoClaw 主进程启动。职责包括：
- 暴露以只读为主的 REST 接口
- 暴露 SSE 事件流，用于状态和日志更新
- 复用现有的 `db.ts`、日志文件和运行配置
- 托管 `apps/web/dist` 构建产物，直接提供 SPA 路由回退
- 暴露一个本地浏览器直聊入口，复用现有容器 agent 链路
- 在直聊请求中透传浏览器 `userAgent`，作为当前客户端环境上下文
- 提供流式直聊响应接口，让前端逐 token 渲染回复
- 避免引入第二个长期运行的后端服务

建议目录结构：
- `src/web/server.ts`
- `src/web/services/*.ts`
- `src/web/types.ts`

### 前端

在 `apps/web/` 下增加 React 应用，技术栈为：
- React
- TypeScript
- Vite
- React Router
- TanStack Query
- Zustand
- react-markdown
- remark-gfm

当前阶段使用自定义 CSS 变量和组件样式，暂不强依赖额外 UI 框架。

## 数据流

当前 UI 主要读取：
- 运行摘要
- 运行配置快照
- 已配置渠道
- 已注册群组
- 最近会话与消息
- 最近日志
- 已调度任务

另外，控制台提供一个本地直聊会话：
- 使用固定 `chat_jid` 标识 Web 会话
- 使用独立的 `group_folder` 保存 agent session 与日志
- 不依赖 Telegram、QQ 等外部渠道即可直接发消息
- 继续复用 `runContainerAgent`，避免产生第二套 agent 调用逻辑
- 在 Web 端逐 token 显示回复内容，并在消息变化时自动滚动到列表底部
- 仅对 Web 直聊启用 token 流，避免影响现有 Telegram 等渠道的一次性消息行为

当前阶段优先只做只读接口，只有直接对话这一项属于受控写操作。

## API 设计

### 当前接口
- `GET /api/health`
- `GET /api/summary`
- `GET /api/runtime`
- `GET /api/channels`
- `GET /api/chats`
- `GET /api/chats/:jid/messages`
- `GET /api/tasks`
- `GET /api/groups`
- `GET /api/groups/:jid/messages`
- `GET /api/sessions`
- `GET /api/logs/app`
- `GET /api/logs/group/:folder`
- `GET /api/events`
- `GET /api/direct-chat/messages`
- `POST /api/direct-chat`
- `POST /api/direct-chat/stream`

### 实时传输方式

当前阶段优先使用 SSE，原因是它已经足够支持：
- 最近日志刷新
- 状态变化通知
- 仪表盘摘要更新

直聊场景额外使用 `NDJSON` 流式响应。容器内 runner 会从 Ollama 获取真正的增量 token，再由宿主 Web API 逐段转发给浏览器。

## UI 信息架构

### 当前页面
- 仪表盘
- 直接对话
- 会话
- 渠道
- 群组列表
- 群组详情
- 任务
- 日志
- 设置 / 运行态

## 集成约束

必须保留以下现有属性：
- 单主 Node.js 进程
- SQLite 作为运行态数据源
- 现有 channel registry 模型
- 现有消息循环和队列模型
- UI 未启用时系统仍可独立运行

## 风险

### 运行复杂度上升
加入 UI 容易把项目推向更重的架构，因此设计上要明确限制：后端保持进程内，只读优先。

### 日志流成本
日志流如果直接粗暴地实时 tail 大文件，可能带来性能问题。当前阶段采用有限窗口的最近日志读取和保守的 SSE 推送。

### 安全性
如果后续 UI 增加更多写操作，就必须引入本地鉴权或类似信任边界。当前阶段仅增加一个本地直接对话入口，其余能力仍保持只读。

### token 流与工具调用的平衡
为了保留工具调用判断能力，runner 会先完成一次决策与工具阶段，再在最终答复阶段对 Web 直聊启用真正的 token 流。这意味着 Web 端看到的是最终回答的 token 级流，而不是工具调用阶段的中间推理流。
