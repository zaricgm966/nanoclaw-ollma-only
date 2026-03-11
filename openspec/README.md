# OpenSpec

该目录用于记录 NanoClaw 的规划中与已完成的重要变更。

## 目录结构

- `specs/`: 当前有效的系统规格说明
- `changes/<change-id>/`: 某次变更的提案、设计和任务追踪

## 工作流

1. 在 `changes/` 下创建新的变更目录
2. 编写 `proposal.md`、`design.md`、`tasks.md`
3. 实施改动
4. 更新 `specs/` 中的当前规格
5. 改动完成后归档该变更

## 默认规则

- 所有重要的产品、架构和流程变更都应先创建 OpenSpec change
- OpenSpec 文档默认使用简体中文编写
- 如需引用英文术语，可在中文语境中保留必要的英文名词
