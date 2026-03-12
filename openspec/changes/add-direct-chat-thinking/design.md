# 设计说明：Web 直聊 thinking 展示

## 总体设计

本次变更沿用现有 Web 直聊流式链路，但把模型增量输出拆成两类：

- `thinking`：模型思考过程
- `content`：最终对用户可见的回复正文

容器内 runner 从 Ollama 流式响应中分别读取 `message.thinking` 和 `message.content`。宿主机收到后通过 `/api/direct-chat/stream` 继续向前端转发为不同事件类型。

## 历史消息持久化

当前直聊消息已经存储在现有消息表中。为了避免增加额外表结构，同时保证刷新页面后仍能看到 thinking，本次将 assistant 消息保存为带标记的单字符串格式：

```text
[[[NANOCLAW_THINKING]]]
...
[[[NANOCLAW_REPLY]]]
...
```

前端展示时解析该结构，分别渲染 thinking 与 reply。

## 历史回灌策略

thinking 只用于前端展示，不应进入后续模型上下文，否则会污染 prompt 并放大无关推理内容。因此 Web 后端在构造直聊 prompt 时，会先移除上述持久化标记，只把最终 reply 回灌给模型。

## 前端交互

- assistant 消息包含 thinking 时，在正文上方显示一个折叠面板
- 正在流式生成 thinking 时默认展开
- thinking 完成后用户可手动折叠或展开
- 当消息发送或回复追加时，聊天区自动滚动到底部

## 兼容性

- 没有 thinking 的旧 assistant 消息仍按原有 Markdown 方式渲染
- 非 Web 直聊链路不依赖 thinking 事件，不受本次变更影响
