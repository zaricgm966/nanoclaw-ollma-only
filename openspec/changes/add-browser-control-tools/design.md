# 设计：基于 Puppeteer 的浏览器控制工具

## 设计思路

新增 `browser-control.ts`，在不破坏既有 `web_search` / `web_fetch` 的前提下，为 agent 提供一组更接近 PinchTab 核心体验的工具函数，并在 `agent-runner` 中将它们注册为可调用工具。

## 核心设计

### 当前活动页面

模块内部维护一个“当前活动页面”：

- 首次调用时自动创建 `Page`
- 后续工具默认作用于同一个页面
- 页面被关闭后可自动重建
- 暂不引入多标签页调度

### 元素定位

在 `browser_snapshot` 时：

- 扫描当前页面中的核心可交互元素
- 为每个元素生成顺序 ID，例如 `el-1`、`el-2`
- 把该 ID 注入 DOM 的 `data-agent-element-id`
- 后续 `browser_click`、`browser_type`、`browser_select` 等动作通过该属性重新定位元素

### 工具集

本轮增加的工具包括：

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_read`
- `browser_screenshot`
- `browser_links`
- `browser_press`
- `browser_select`
- `browser_hover`
- `browser_wait_for_text`

其中：

- `browser_snapshot` 负责把页面状态和元素映射暴露给 agent
- `browser_read` 负责提取当前页面主文本，便于直接喂给 LLM
- `browser_screenshot` 负责沉淀页面截图，便于后续展示或调试

## runner 集成

`agent-runner` 需要同步扩展：

- 工具白名单
- 系统提示中的工具说明
- JSON 工具调用解析
- 工具执行分发逻辑

这样 agent 才能在输出工具调用 JSON 后，真正触发对应的浏览器控制函数。

## 结果格式

浏览器动作尽量返回结构化结果，至少包含：

- `ok`
- `action`
- `url`
- `title`
- `domain`
- `message`
- `textPreview`

对于 `browser_snapshot`，还需额外返回交互元素列表；对于 `browser_links`，返回链接数组；对于 `browser_read`，返回可直接喂给模型的纯文本内容。
