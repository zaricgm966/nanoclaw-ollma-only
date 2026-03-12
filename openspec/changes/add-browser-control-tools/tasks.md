# 任务：增加 agent 浏览器控制工具层

## OpenSpec

- [x] 创建本次变更的 proposal、design 和 tasks
- [x] 新增浏览器控制规格说明

## 实现

- [x] 新增 `browser-control.ts` 并复用现有浏览器基础设施
- [x] 实现当前活动页面管理
- [x] 实现页面快照与可交互元素列表提取
- [x] 实现点击、输入、滚动、回退、前进、刷新等基础动作
- [x] 实现主文本读取、截图、链接提取等辅助能力
- [x] 将浏览器控制工具注册到 `agent-runner` 的工具白名单与执行分发
- [x] 更新系统提示，指导 agent 正确使用 `browser_snapshot` 和元素 ID

## 验证

- [x] 通过 `container/agent-runner` 的 TypeScript 构建验证
- [x] 验证新工具不会破坏既有 `web_search` / `web_fetch`
- [ ] 追加一次真实页面多步操作验证
