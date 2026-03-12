# 设计说明：宿主机工具请求/响应

## 总体设计

容器内 runner 继续运行在隔离环境中，不直接访问宿主机。对于需要宿主机执行的动作，runner 通过组级 IPC 目录写入请求文件，宿主机主进程监听后执行并写回结果文件。

目录结构：

- `data/ipc/<group>/host-tools/requests`
- `data/ipc/<group>/host-tools/results`

## 首批工具

- `open_app`：按名称或路径请求宿主机打开应用
- `take_screenshot`：请求宿主机截取当前桌面，并返回保存路径

## 安全边界

- 工具请求按 group 目录命名空间隔离
- 容器只能请求宿主机暴露出来的固定工具，不具备任意命令执行权限
- 本次不提供任意 shell 执行能力

## 文档一致性

全局记忆与主群记忆将不再宣称 agent 可以直接运行 Bash 或使用未接线的 `agent-browser`。改为只声明真实存在的 Web 工具和宿主机工具。
