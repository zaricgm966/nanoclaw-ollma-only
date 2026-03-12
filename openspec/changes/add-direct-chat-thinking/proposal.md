# 变更提案：为 Web 直聊展示 thinking 阶段

## 背景

当前 NanoClaw 的 Web 直接对话页已经支持流式回复与 Markdown 渲染，但用户无法看到模型在生成最终回答前的 thinking 阶段，也无法在回复完成后收起这部分内容。这会让网页端体验和底层模型能力脱节，也不利于排查联网搜索、工具调用等复杂问题。

## 目标

- 在 Web 直接对话页展示模型的 thinking 阶段
- thinking 与最终回答分开展示
- thinking 生成完成后允许用户折叠或展开
- 该能力与现有流式直聊兼容，不影响 Telegram 等其他渠道
- thinking 内容可以在页面刷新后继续查看

## 非目标

- 不要求 Telegram、QQ 等消息渠道展示 thinking
- 不要求为 thinking 增加单独数据库表
- 不要求为所有历史消息补齐 thinking 数据

## 影响范围

- `container/agent-runner` 流式输出协议
- Web API 的直聊流式接口与历史消息处理
- Web 直接对话页的渲染与交互
- Web 控制台规格文档
