# 设计：基于 Puppeteer 的搜索与抓取工具

## 设计思路

在容器内的 agent runner 中增加浏览器抓取模块，统一承载：

- `web_search`
- `web_fetch`

该模块使用容器内已有的 Chromium，并通过 `puppeteer-core` 驱动浏览器。

## 工具行为

### web_search

- 打开 DuckDuckGo HTML 搜索页
- 提取标题与目标链接
- 返回前 5 条结果

### web_fetch

- 打开目标网页
- 提取 `title`、`meta description` 和正文文本
- 将正文裁剪到固定长度，避免上下文爆炸

## 触发策略

保留模型自主工具调用能力，同时增加一层宿主兜底：

- 如果请求被判定为明显需要联网
- 且模型在第一轮没有主动输出工具调用 JSON
- runner 自动执行一次 `web_search`
- 再把搜索结果回灌给模型继续回答

这样可以降低“模型明明能联网，却口头拒绝联网”的情况。

## 运行约束

- 浏览器优先复用单例，减少每次抓取的冷启动成本
- 浏览器可复用容器中已有 Chromium 路径
- 若配置了 `HTTP_PROXY/HTTPS_PROXY`，浏览器启动时自动带上代理参数
