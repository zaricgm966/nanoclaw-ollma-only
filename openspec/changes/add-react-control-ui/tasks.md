# 任务：增加 React 控制台

## OpenSpec

- [x] 创建 OpenSpec 目录结构
- [x] 增加 Web 控制台与变更管理的基础规格
- [x] 为第一期 Web UI 改动编写 proposal、design 和 tasks

## 后端基础层

- [x] 增加 `src/web/` 服务入口与路由结构
- [x] 增加 health、summary、groups、sessions、logs 的最小 REST 接口
- [x] 增加运行态更新的 SSE 接口
- [x] 增加统一响应与错误处理辅助层
- [x] 增加 runtime 只读配置快照接口
- [x] 增加本地 Web 直接对话接口与独立会话持久化
- [x] 增加 Web 直聊的 userAgent 上下文透传
- [x] 增加 Web 直聊的流式响应接口
- [x] 增加基于 Ollama 的 token 级流式输出链路

## 前端基础层

- [x] 创建 `apps/web/` React + TypeScript + Vite 应用
- [x] 增加路由、query client、全局状态与基础布局
- [x] 增加设计变量与基础样式
- [x] 增加仪表盘页面
- [x] 增加群组列表页面
- [x] 增加群组详情页面
- [x] 增加日志页面
- [x] 增加会话页面
- [x] 增加渠道页面
- [x] 增加任务页面
- [x] 增加设置 / 运行态页面
- [x] 增加直接对话页面
- [x] 增加聊天自动滚底
- [x] 增加 Markdown / GFM 渲染
- [x] 增加前端流式消息展示

## 集成

- [x] 将前端开发命令接入根目录 scripts
- [x] 决定生产环境前端构建产物的托管方式
- [ ] 增加本地运行 UI 的文档

## 验证

- [x] 验证加入 Web 服务代码后，现有渠道运行不受影响
- [x] 验证 UI 可以从 NanoClaw 后端读取实时或近期数据
- [x] 接入 SSE 到前端摘要和日志刷新
- [x] 验证主进程可直接托管前端静态资源与 SPA 路由
- [x] 验证 Web 控制台可直接发起本地对话并收到 agent 回复
- [x] 验证 Web 直聊可携带 userAgent 辅助识别当前系统
- [x] 验证 Web 直聊页面可显示 token 级流式回复与 Markdown 内容
- [x] 如实现范围变化，及时更新 specs
