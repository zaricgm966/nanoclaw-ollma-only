# Agent 浏览器控制规格

## 状态
草案

## 概述

NanoClaw 的 Ollama-only agent 可以通过内建浏览器控制工具，围绕同一个当前活动页面执行导航、快照、元素操作、正文读取与截图等动作。

## 需求

### 需求：浏览器导航工具
NanoClaw 必须提供可由 agent 调用的页面导航能力。

#### 场景：打开网页
- 假设 agent 需要访问某个网页
- 当 agent 调用 `browser_navigate`
- 那么系统会打开该网页并返回最终 URL、标题、域名和页面文本摘要

### 需求：页面快照与元素映射
NanoClaw 必须提供页面快照能力，并暴露可交互元素列表。

#### 场景：识别页面可操作元素
- 假设 agent 已打开一个网页
- 当 agent 调用 `browser_snapshot`
- 那么系统会返回页面主要文本，以及带有稳定 `elementId` 的可交互元素列表

### 需求：基于 elementId 的页面操作
NanoClaw 必须允许 agent 基于快照生成的 `elementId` 操作页面。

#### 场景：点击页面元素
- 假设 agent 已拿到页面快照中的 `elementId`
- 当 agent 调用 `browser_click`
- 那么系统会点击目标元素并返回点击后的页面摘要

#### 场景：向输入框填写内容
- 假设 agent 已拿到一个输入元素的 `elementId`
- 当 agent 调用 `browser_type`
- 那么系统会向该元素输入文本，并在需要时清空或提交

### 需求：浏览器状态延续
NanoClaw 必须在多步工具调用之间保留当前活动页面。

#### 场景：连续执行多步浏览器动作
- 假设 agent 先调用 `browser_navigate`
- 且随后调用 `browser_snapshot`、`browser_click` 或 `browser_read`
- 当这些调用发生在同一轮连续操作中
- 那么系统必须默认继续使用同一个当前活动页面
