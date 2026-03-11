# 任务：增加基于浏览器的联网搜索

## OpenSpec

- [x] 创建本次变更的 proposal、design 和 tasks
- [x] 更新现行规格说明中的联网工具行为

## 实现

- [x] 增加浏览器抓取模块并封装 `web_search`
- [x] 增加浏览器抓取模块并封装 `web_fetch`
- [x] 将 agent runner 的工具执行切换到浏览器抓取实现
- [x] 增加明显联网请求的自动搜索兜底逻辑
- [x] 为 runner 增加依赖并更新 lockfile

## 验证

- [x] 通过 TypeScript 构建验证 runner 编译通过
- [x] 验证搜索型问题会触发浏览器搜索
- [x] 验证网页抓取结果可回灌给模型生成最终回复
