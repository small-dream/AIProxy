# Session Inspector 重构方案与实施计划

## 1. 文档信息

- 文档名称：`Session Inspector 重构方案与实施计划`
- 适用范围：桌面端 Sessions 页面请求详情区
- 目标阶段：`P0 + P1 半套`
- 当前状态：`Draft v1`
- 关联实现：
  - `apps/desktop/src/pages/sessions/index.tsx`
  - `apps/desktop/src/features/sessions/components/SessionInspectorWorkspace.tsx`
  - `packages/shared-types/src/index.ts`
  - `apps/desktop/src/services/commands/index.ts`

## 2. 背景与问题

当前 Inspector 详情区已经具备基础的会话概览、headers、text、hex、raw 等展示能力，但与 Charles 风格的专业抓包详情面板仍有明显差距：

- 当前为单内容流，不是 `Request / Response` 上下双区结构
- request 与 response 没有独立滚动区域
- request 区无法折叠，也无法单独控制空间占比
- 详情 tab 维度过粗，缺少对 query、form、json 等常见内容的语义拆分
- 没有详情区内搜索
- 没有 JSON 树视图
- 对大 JSON 没有性能保护策略

本次改造目标是在现有架构上先完成一版可交付的 `P0 + P1 半套`，优先建立正确的信息架构、交互骨架与后续扩展能力。

## 3. 本次目标

### 3.1 核心目标

将当前单区 Inspector 重构为接近 Charles 的双区工作台：

- 上方 `Request` 区
- 下方 `Response` 区
- 两区独立滚动
- request 区支持折叠/展开
- 中间 splitter 支持拖拽调整上下占比
- 占比与折叠状态持久化
- request / response 各自拥有独立 tab 和搜索
- response 支持 `JSON` 与 `JSON Text` 两种视图
- 对大 JSON 提供惰性解析与降级策略

### 3.2 本次交付范围

本次先交付 `P0 + P1 半套`：

- 完成双区布局、折叠、拖拽、独立滚动
- 完成 request / response 基础 tab 拆分
- 完成 query、headers、text、raw、json、json text 等主要视图
- 完成基础搜索能力
- 完成大 JSON 的第一层性能保护

### 3.3 暂不纳入本次范围

以下能力不在本次第一轮实现内：

- 完整 Hex 专业查看器增强功能
- 响应图片 / HTML 预览模式
- 真正的虚拟滚动 JSON 树
- 增量流式 body 加载
- response cookies 与 request cookies 的后端单独结构化输出
- 二进制 body 的高级分析工具

## 4. 目标交互形态

### 4.1 页面结构

```text
[Session Inspector Workspace]
┌─────────────────────────────────────────────────────────────┐
│ Summary Bar                                                │
│ GET /api/users    200 OK   128 ms   12.4 KB                │
├─────────────────────────────────────────────────────────────┤
│ [Request Pane]                                             │
│ Title + Collapse + Search + Tabs                           │
│ <Overview> <Query> <Headers> <Body> <Form> <Raw>           │
│ .........................................................   │
├────────────── draggable splitter ───────────────────────────┤
│ [Response Pane]                                            │
│ Title + Search + Tabs                                      │
│ <Overview> <Headers> <Text> <JSON> <JSON Text> <Raw>       │
│ .........................................................   │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 默认行为

- 默认上下占比：`Request 38% / Response 62%`
- request 默认展开
- 拖拽后记忆用户上次占比
- 折叠 request 后仅保留标题摘要栏
- 切换 session 时保留当前 tab 偏好，但内容跟随当前 session 更新
- 每个 pane 内部内容独立滚动，不影响另一半区域

## 5. 信息架构

## 5.1 Request Pane Tabs

- `Overview`
  - Method
  - URL
  - Host
  - Path
  - Protocol
  - Started / Finished
  - Body 概况
- `Query`
  - GET 参数表格展示
- `Headers`
  - 请求头键值列表
- `Body`
  - 自动选择文本 / JSON / 原始文本视图
- `Form`
  - 对 `application/x-www-form-urlencoded` 或 `multipart/form-data` 做结构化展示
- `Raw`
  - 原始请求报文

## 5.2 Response Pane Tabs

- `Overview`
  - Status Code
  - Duration
  - Size
  - MIME Type
  - Encoding
  - Server IP
- `Headers`
  - 响应头键值列表
- `Text`
  - 文本内容视图
- `JSON`
  - JSON 树视图，支持展开/折叠
- `JSON Text`
  - 格式化 JSON 文本
- `Raw`
  - 原始响应报文 / 响应 body 原文

## 5.3 搜索能力

每个 pane 各自有一个搜索输入框：

- 默认搜索当前 tab 内容
- 空状态不显示结果条
- 有结果时显示命中数量
- 文本视图中高亮关键词
- JSON 视图中匹配 key / value
- JSON 命中时自动展开到命中节点路径

本次先实现基础搜索：

- 不做正则
- 不做大小写切换
- 不做全局跨 tab 聚合搜索

## 6. 内容视图策略

### 6.1 Request Body 识别规则

优先级：

1. `application/json` → `JSON / JSON Text`
2. `application/x-www-form-urlencoded` → `Form`
3. `multipart/form-data` → `Form`
4. 其他可文本化内容 → `Text`
5. 无法识别或缺少文本 → 退回 `Raw`

### 6.2 Response Body 识别规则

优先级：

1. `application/json` 或文本内容可安全解析为 JSON → `JSON`
2. `text/*` 或文本型内容 → `Text`
3. 有 `inlineText` 则优先展示为文本内容
4. 无文本内容则显示提示，回退到 `Raw`

## 7. 性能设计

JSON 是本次性能风险最高的区域，必须先做保护。

### 7.1 惰性解析

不在详情区初次渲染时立即解析所有 JSON。

策略：

- 只有当用户进入 `JSON` 或 `JSON Text` tab 时才尝试解析
- `Text` / `Headers` / `Overview` 不触发 JSON 解析

### 7.2 大 JSON 降级阈值

建议阈值：

- `<= 256 KB`：直接解析并展示 JSON 树
- `256 KB ~ 2 MB`：懒解析，首次进入 JSON tab 时解析
- `> 2 MB`：默认先提示内容过大，优先使用 `JSON Text`，树视图仅在用户主动进入时尝试

### 7.3 树视图渲染策略

本次先实现轻量树视图：

- 默认仅展开根节点
- 用户手动展开子节点
- 仅渲染当前可见展开链路
- 不一次性默认全展开

后续如仍有性能问题，再进入虚拟化方案。

### 7.4 搜索策略

- 搜索时基于已解析 JSON 递归遍历
- 仅记录命中路径，不做复杂全文索引
- 对超大 JSON 搜索失败或成本过高时，优先提示用户切到 `JSON Text`

## 8. 组件拆分方案

建议将现有单一组件拆分为以下结构：

```text
SessionInspectorWorkspace
├─ InspectorSummaryBar
├─ InspectorSplitView
│  ├─ InspectorPane (request)
│  │  ├─ InspectorPaneHeader
│  │  ├─ InspectorSearchBar
│  │  ├─ RequestTabs
│  │  └─ RequestTabPanel
│  ├─ InspectorPaneResizeHandle
│  └─ InspectorPane (response)
│     ├─ InspectorPaneHeader
│     ├─ InspectorSearchBar
│     ├─ ResponseTabs
│     └─ ResponseTabPanel
├─ KeyValueTable
├─ SearchableCodeBlock
├─ JsonTreeViewer
└─ EmptyState / ErrorState
```

### 8.1 组件职责

- `SessionInspectorWorkspace`
  - 负责摘要信息、布局总控、detail loading / error 状态
- `InspectorSplitView`
  - 负责上下比例、拖拽、折叠、持久化
- `InspectorPane`
  - 负责 pane 标题、搜索、tabs、tab 内容容器
- `KeyValueTable`
  - 负责 headers / query / form 的统一渲染
- `SearchableCodeBlock`
  - 负责 text / raw / json text 的高亮搜索展示
- `JsonTreeViewer`
  - 负责 JSON 树视图、展开折叠、搜索命中自动展开

## 9. 状态模型设计

建议将详情区 UI 状态扩展为：

```ts
type InspectorPaneTab = {
  request: "overview" | "query" | "headers" | "body" | "form" | "raw";
  response: "overview" | "headers" | "text" | "json" | "jsonText" | "raw";
};

type InspectorUiState = {
  requestTab: InspectorPaneTab["request"];
  responseTab: InspectorPaneTab["response"];
  requestCollapsed: boolean;
  splitRatio: number;
  requestSearch: string;
  responseSearch: string;
};
```

本次优先把这些状态保留在 `SessionsPage`，避免过早引入额外 store。

## 10. 数据结构建议

当前 `SessionDetail` 已有：

- `requestHeaders`
- `responseHeaders`
- `requestBody`
- `responseBody`
- `queryParams`
- `cookies`
- `rawRequest`
- `rawResponse`
- `timing`

本次先尽量复用现有结构，不强制改后端协议。

前端通过 `mimeType`、`inlineText`、`rawRequest`、`rawResponse` 做 viewer 推断。

如后续需要更强能力，再考虑扩展：

- `requestCookies`
- `responseCookies`
- `parsedFormFields`
- `detectedBodyKind`
- `prettyText`
- `bodyTruncatedReason`

## 11. 详细实施计划

## 11.1 P0：骨架重构

### Step 1：重构页面状态

修改 `apps/desktop/src/pages/sessions/index.tsx`：

- 删除旧的 `primaryInspectorTab` / `secondaryInspectorTab`
- 新增：
  - `requestTab`
  - `responseTab`
  - `requestCollapsed`
  - `inspectorSplitRatio`
- 为 `requestCollapsed` 和 `inspectorSplitRatio` 增加 localStorage 持久化

### Step 2：重构详情主组件

修改 `apps/desktop/src/features/sessions/components/SessionInspectorWorkspace.tsx`：

- 移除旧的 primary/secondary tab 结构
- 新增 summary bar
- 新增上下双 pane 布局
- 新增 request pane 折叠交互
- 新增中间 splitter 拖拽交互
- 为两区内容容器分别设置独立滚动

### Step 3：建立统一的 pane 头部和内容渲染器

在现有文件内先内聚实现，避免首轮拆太多文件：

- pane 标题栏
- 搜索框
- tab bar
- tab 内容选择器

完成后再根据体量决定是否拆文件。

## 11.2 P1：主要内容能力

### Step 4：实现 Request tabs

- `Overview`
- `Query`
- `Headers`
- `Body`
- `Form`
- `Raw`

### Step 5：实现 Response tabs

- `Overview`
- `Headers`
- `Text`
- `JSON`
- `JSON Text`
- `Raw`

### Step 6：实现搜索高亮

- 文本类 tab：使用轻量高亮切分实现
- key-value tab：仅过滤匹配项
- JSON 树：命中后展开父路径并高亮 key / value

### Step 7：实现 JSON 树与 JSON Text

- 添加安全 JSON 解析函数
- 添加内容体积阈值判断
- 添加树形节点组件
- 解析失败时回退到 `JSON Text` 或错误提示

## 11.3 收尾与验证

### Step 8：验证交互

至少验证以下场景：

- request 折叠/展开
- 上下拖拽比例持久化
- request/response 独立滚动
- query / headers / raw 正常展示
- JSON tab 可正常解析小 JSON
- 大 JSON 不会在初次进入详情页时卡死
- 搜索输入不会影响另一半 pane

### Step 9：代码质量校验

执行：

- typecheck
- desktop build 或最小范围验证

## 12. 验收标准

完成后应满足：

- 详情区已变为上下双 pane
- request pane 可折叠
- splitter 可拖拽，比例可记忆
- request 与 response 各自独立滚动
- request 至少支持 overview/query/headers/body/raw
- response 至少支持 overview/headers/text/json/json text/raw
- JSON 支持树形展开/折叠
- 文本 / JSON / headers 支持基础搜索
- 大 JSON 至少有首层性能保护，不会在默认详情展示中无脑全量解析

## 13. 风险与应对

### 风险 1：当前数据结构不足以完美支撑 Form / Cookies 细分

应对：

- 首轮通过 header/body 推断生成前端结构化视图
- 后续如必要再扩展 shared-types

### 风险 2：大 JSON 树渲染卡顿

应对：

- 延迟解析
- 根节点默认折叠
- 控制默认展开数量
- 必要时回退 `JSON Text`

### 风险 3：单文件组件过大

应对：

- 首轮先完成正确交互
- 体量超出阈值后再拆分独立子组件

## 14. 推荐实施顺序

推荐严格按以下顺序执行：

1. 页面状态重构
2. 双区布局 + 折叠 + splitter
3. request/response tab 框架
4. query/headers/raw/text 基础内容
5. 搜索
6. JSON Text
7. JSON 树
8. 性能保护
9. 验证与收尾

## 15. 本次实施边界结论

本次按 `P0 + P1 半套` 实施时，优先级顺序如下：

- 第一优先级：双区布局与交互骨架正确
- 第二优先级：常用内容查看方式齐全
- 第三优先级：JSON 可用且不拖垮性能
- 第四优先级：交互细节逐步接近 Charles

这意味着本轮实现不追求一步到位复刻 Charles 的全部细节，而是先把高频使用路径、结构合理性和性能底线建立起来。