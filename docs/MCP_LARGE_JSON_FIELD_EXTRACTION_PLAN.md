# MCP 大 JSON 字段按需提取方案

## 1. 文档信息

- 文档类型：技术方案与实施计划
- 文档状态：`Proposed（已按代码核实修订，待实现）`
- 更新日期：`2026-10-30`
- 适用范围：`crates/mcp-server`、`crates/db` 的只读 Body 访问、Agent Access、内置 AIProxy Skill、MCP 帮助文档
- 关联文档：
  - `docs/API_SPEC.md`
  - `docs/MCP_AGENT_SKILL_ARCHITECTURE.md`
  - `docs/MCP_AGENT_LOOP_PLAN.md`
  - `apps/desktop/src-tauri/resources/agent-skill/aiproxy/SKILL.md`
  - `apps/desktop/user-guides/zh-CN/agent-access.md`
  - `apps/desktop/user-guides/en/agent-access.md`

## 2. 背景

当前 `get_session_body` 的 `jsonPaths` 已经能只返回目标字段，但实现方式仍是先读取并完整反序列化整个 JSON，再整体脱敏，最后提取路径。为此设置了 `8 MiB` 的完整扫描上限。

实测 `pb.photoaffections.com` 的 `app.launch` 响应：

- `wireSizeBytes: 298107`
- `decodedSizeBytes: 9084082`
- sessionId：`43ffa42e-3525-49a7-8463-51c7a1fb8bc2`

响应解压后约 `8.66 MiB`，超过完整扫描上限。结果是即使只想读取 `$.local_premade_wizard_config_rc`，`redacted-text` 和 `jsonPaths` 都会返回 `BODY_TOO_LARGE`。

这不仅限制能力，也违背 Agent 接入的成本目标：Agent 往往只需要一个业务字段，却被迫面对完整响应或无法读取。需要把策略从“完整读取后提取”改成“流式定位目标节点，只返回所需数据”。

## 3. 代码核实结论

本节记录方案评审时对现有代码的核实结果，后续设计以此为准。

### 3.1 截断值无法继续下钻

`bounded_json_value` 当前会把超过 `64 KiB` 的对象或数组整体序列化后转成截断字符串。Agent 只能看到字符串开头，无法知道后续 key，因此“请求更具体子路径”的建议在目标节点超限时不可执行。

结论：必须新增有上限的结构摘要，至少返回直接子 key、类型、可计算的大小和数组长度。这不是完整 key 枚举功能，输出预算固定且不递归。

### 3.2 `jsonPaths` 不能保留两套实现

已核实当前 `serde_json` 未启用 `preserve_order`：

- 旧路径中的 `Value` 对象按 key 排序，`[*]` 的对象遍历顺序与原文不同。
- 流式解析按源文件顺序，输出顺序会与旧路径不同。
- `serde_json::Value` 对重复 key 取最后一个；流式解析若命中即停会得到第一个。
- `viewSizeBytes` 若只对大于 `8 MiB` 的路径重定义，会产生同字段两种语义。

结论：所有带 `jsonPaths` 的请求统一走流式提取。`8 MiB` 只保留给 `textQuery`、完整脱敏文本和无法安全流式处理的全根值场景。

### 3.3 脱敏语义比原计划更细

已核实 `redact_scalar` 与 `redact_object` 的行为：

- Secret 类字段返回 `[REDACTED]`。
- Identifier / PII 类标量在开启 `hash_identifiers` 时返回 `ID` / `EMAIL` / `PHONE` 伪名，不一定是 `[REDACTED]`。
- 敏感字段值是对象或数组时，当前实现整体替换为 `[REDACTED]`。
- `redact_json_value` 的第二个参数是路径前缀；流式提取必须传目标节点的真实路径，不能统一传 `$`。

结论：流式实现不能复制一套近似逻辑，应把 `redact_object` 中“单个命名字段”的判断抽成可复用方法，旧路径和新路径共同调用。

### 3.4 截断抓包和 UTF-8 行为必须明确

- 捕获响应先受 `20 MiB` wire 上限约束；解压成功时 Body Store 保存解码后的字节，解压失败或超过 `64 MiB` 解压上限时可能回退到原始 wire bytes。
- `captureTruncated=true` 表示抓包阶段已经截断；此时存盘 JSON 可能不完整，也可能因回退原始压缩字节而不是 JSON。
- 旧路径在不完整 JSON 上返回 `BODY_NOT_JSON`。
- 跳过字符串时不能依赖“没有对外输出”来免除 UTF-8 校验。

结论：

- 流式解析必须消费并验证完整文档后才返回结果，不允许“已经找到字段但文件尾部解析失败”时返回部分成功。
- file-backed Body 先做全量 UTF-8 校验，或在读取包装器中持续校验 UTF-8 边界；校验失败统一返回 `BODY_NOT_JSON`。
- `captureTruncated=true` 且解析失败时返回 `BODY_NOT_JSON`，并在 details 中保留 `captureTruncated`，不返回部分字段。
- 如果截断后的字节恰好仍是完整 JSON，可以返回字段，但必须保留 `captureTruncated=true` 与 `captureLimit`，调用方不得把结果视为完整抓包。

### 3.5 资源与执行线程

- 当前 Body 解析直接在 tokio 运行时线程上执行，只有数据库访问使用 `spawn_blocking`。
- `get_session_fields` 最多处理 20 个 session；如果每个都按 `64 MiB` 扫描，最坏约 `1.28 GiB`，会长时间阻塞运行时。
- 目标节点当前先完整构建 `Value`，再做 `64 KiB` 截断；路径为 `$` 或目标节点很大时，内存峰值会显著高于返回大小。
- `[*]` 的匹配结果数量没有独立上限，最终 `1 MiB` 响应限制发现得太晚。

结论：解析和脱敏必须移入 `spawn_blocking`；批量调用增加总扫描预算；扫描过程中就执行单值、匹配数和总结果预算。

### 3.6 文件读取与递归深度

- Body Store 文件保存的是解码后字节，可以直接通过安全的只读 reader 流式读取，不需要先读成完整 `Vec<u8>`。
- 当前 `aiproxy-mcp` 的依赖图没有启用 `serde_json/preserve_order` 或 `serde_json/unbounded_depth`；`cargo_metadata` 不在 `aiproxy-mcp` 的正式依赖图中。
- 即便如此，仍应设置显式 JSON 深度上限并加入测试，避免未来 workspace 特性合并改变行为。

### 3.7 `compare_sessions` 提示

已核实 `compare_sessions` 当前的 `BODY_TOO_LARGE` 文案没有建议改用 `jsonPaths`；它只说明任一侧超过扫描上限。

结论：保持这一中性提示，并增加回归测试，禁止后续文案暗示“改用 jsonPaths 就能绕过比较上限”。

## 4. 目标

1. 已知 key 或 JSONPath 时，Agent 可以只获取目标节点，不获取、不下载、不分页完整 JSON。
2. 所有 `jsonPaths` 提取使用同一套流式语义，不受 `8 MiB` / `64 MiB` 两套实现影响。
3. 大 JSON 的字段提取不要求完整反序列化为 `serde_json::Value`，只物化目标子树或结构摘要。
4. 继续复用现有脱敏、权限、审计、输出预算和截断信号。
5. Agent 工具说明与 Skill 明确要求“按需取数”，避免无意义地浪费 token。
6. `get_session_body` 与 `get_session_fields` 行为一致。

示例目标：

```json
{
  "sessionId": "43ffa42e-3525-49a7-8463-51c7a1fb8bc2",
  "part": "response",
  "redactionMode": "redacted-text",
  "jsonPaths": ["$.local_premade_wizard_config_rc"]
}
```

响应只应包含该节点的脱敏结果或结构摘要，以及必要元数据，而不是 9 MB Body。

## 5. 非目标

- 不新增第二个“读取 JSON”的工具；继续使用 `get_session_body` / `get_session_fields` 的 `jsonPaths`。
- 不提供递归列出完整 key 树的模式；只提供有固定预算的一层结构摘要。
- 不改变 `textQuery` 的语义。`textQuery` 仍搜索完整脱敏文本视图，受 `8 MiB` 上限约束。
- 本方案不扩大 `compare_sessions` 的 Body 比较上限。
- 不降低 `raw` / `base64` 的权限和审计要求。
- 不悄悄接受 `$local_x` 之类的非标准路径；返回 `JSON_PATH_INVALID`，提示应写为 `$.local_x`。

## 6. Agent 按需取数契约

这是本方案的优先级最高部分。后端即使支持流式提取，如果 Agent 仍默认请求完整 Body，token 成本不会改善。

### 6.1 必须遵守的读取顺序

1. 用 `search_sessions` + `compact=true` 定位 `sessionId`，只获取摘要。
2. 需要查看 JSON 字段时，优先一次调用：

   ```json
   {
     "sessionId": "<sessionId>",
     "part": "response",
     "redactionMode": "redacted-text",
     "jsonPaths": ["$.target.field"]
   }
   ```

3. 多个目标字段合并到同一次 `jsonPaths` 调用，最多 20 个路径。
4. 目标节点超限时，先读取 `valueSummary` 中的一层 key 信息，再请求更具体的子路径。
5. 只有路径未知时，才使用 `metadata` 或有明确上限的 `textQuery` 帮助定位；不能把 `textQuery` 当作完整 Body 下载手段。
6. `raw` / `base64` 仅在用户明确要求未脱敏内容或二进制数据时使用。

### 6.2 明确禁止

- 为了读取一个已知 JSON key，先调用无 `jsonPaths` 的 `redacted-text` 读取完整 Body。
- 为了恢复一个大 JSON 字段，用 `offset` + `maxBytes` 分页下载整个 Body。
- 在 `BODY_TOO_LARGE` 后反复尝试相同参数或简单增大 `maxBytes`。
- 在 `RESULT_TOO_LARGE` 后重复同一调用，而不缩小字段范围。
- 在没有用户明确要求时开启或使用 `readRawBodies`。

### 6.3 需要写入 Agent 可见说明的文字

建议在 MCP 工具描述和内置 `aiproxy/SKILL.md` 中同时写入：

> When a JSON key path is known, always use `jsonPaths` and return only that subtree. Never page through a large JSON response to recover a field. If a value is truncated, inspect the bounded `valueSummary` and request a narrower child path instead of fetching the full body.

建议的中文帮助说明：

> 已知 JSON 字段路径时，必须使用 `jsonPaths` 只读取目标节点。不要为了获取一个字段而分页读取完整响应；目标值被截断时，先查看受限的结构摘要，再请求更具体的子路径。

## 7. API 行为设计

### 7.1 继续使用 `jsonPaths`

路径语法保持不变：

- `$`
- `$.local_premade_wizard_config_rc`
- `$['local_premade_wizard_config_rc']`
- `$.items[0].name`
- `$.items[*].name`

`$local_premade_wizard_config_rc` 不是有效语法，不自动修正；错误详情应包含正确示例。

### 7.2 统一流式语义

所有 `jsonPaths` 请求都走同一套流式提取器，不再按 Body 大小切换实现。

| 请求 | 行为 |
|---|---|
| `jsonPaths`，Path 不是 `$` | 流式提取，完整验证文档，只物化目标子树或其结构摘要 |
| `jsonPaths`，Path 为 `$`，Body `<= 8 MiB` | 允许，按普通目标节点处理 |
| `jsonPaths`，Path 为 `$`，Body `> 8 MiB` | 返回 `BODY_TOO_LARGE`，提示改用具体字段路径或 `valueSummary` |
| `jsonPaths` + `textQuery`，Body `<= 8 MiB` | 字段流式提取，同时按现有逻辑执行文本搜索 |
| `jsonPaths` + `textQuery`，Body `> 8 MiB` | 拒绝混合请求，提示拆开调用 |
| `textQuery`，Body `> 8 MiB` | 返回 `BODY_TOO_LARGE`，完整脱敏文本搜索仍受 `8 MiB` 限制 |

### 7.3 顺序与重复 key

为了统一语义，建议明确：

- 数组按原索引顺序返回。
- 对象通配符按源文件中的 key 出现顺序返回。
- 对同一对象中的重复 key，沿用 `serde_json::Value` 的“最后一个值生效”语义。
- 该规则与旧 `Value` 路径在对象通配符的排序行为上不同，但所有 `jsonPaths` 请求统一后不会出现同请求多种语义；需在 API 文档和测试中固定。

### 7.4 响应结构

沿用现有 `jsonPaths[]` 结果结构，并补齐现有字段：

```json
{
  "sessionId": "43ffa42e-3525-49a7-8463-51c7a1fb8bc2",
  "part": "response",
  "contentType": "application/json",
  "contentEncoding": "utf-8",
  "encoding": "json",
  "isUtf8": true,
  "text": null,
  "base64": null,
  "jsonPaths": [
    {
      "path": "$.local_premade_wizard_config_rc",
      "found": true,
      "value": {},
      "valueType": "object",
      "matchCount": 1,
      "truncated": false,
      "valueSummary": null
    }
  ],
  "textMatches": [],
  "wireSizeBytes": 298107,
  "decodedSizeBytes": 9084082,
  "viewSizeBytes": 812,
  "offsetUnit": "none",
  "offset": 0,
  "returnedBytes": 812,
  "nextOffset": null,
  "hasMore": false,
  "captureTruncated": false,
  "scanTruncated": false,
  "truncatedReasons": [],
  "redactedFields": [],
  "structureParsed": true,
  "hash": {
    "algorithm": "sha256",
    "value": "<sha256>",
    "scope": "decodedBody"
  }
}
```

语义约定：

- `decodedSizeBytes` 表示完整 Body 大小，不代表返回大小。
- `returnedBytes` 只统计本次目标字段结果，不包含被跳过的 Body。
- 所有 `jsonPaths` 响应统一使用“提取结果视图大小”作为 `viewSizeBytes`，不再按 Body 大小切换语义。
- `structureParsed=true` 表示完整文档已成功解析；流式路径不会返回部分解析结果。
- `hash` 继续表示整个 decoded Body 的 SHA-256，可在读取过程中增量计算。
- 找不到路径时返回 `found=false`，不报错。
- 非 JSON 或 UTF-8 校验失败返回 `BODY_NOT_JSON`；非法 JSONPath 返回 `JSON_PATH_INVALID`。

### 7.5 截断值与结构摘要

对象或数组超过 `64 KiB` 时，不再把完整前缀塞成截断字符串。建议返回：

```json
{
  "value": null,
  "valueType": "object",
  "truncated": true,
  "valueSummary": {
    "kind": "object",
    "keyCount": 48,
    "returnedKeys": 16,
    "keys": [
      { "name": "a", "kind": "string", "sizeBytes": 12 },
      { "name": "b", "kind": "object", "sizeBytes": null }
    ],
    "arrayLength": null
  }
}
```

约束：

- 只返回目标节点的一层摘要，不递归展开。
- 最多返回 `32` 个 key，摘要总大小最多 `4 KiB`。
- 数组返回 `arrayLength`；对象返回 `keyCount` / `returnedKeys` / `keys`。
- 标量大小可准确计算时返回 `sizeBytes`；复杂子节点可返回 `null`，避免为了测量大小再次整棵物化。
- 目标标量超限时可继续返回有界前缀，并同时提供 `valueSummary`。
- `truncatedReasons` 增加 `resultLimit`。

## 8. 后端实现设计

### 8.1 文件读取

新增 `BodyStore` 的只读 reader API，例如 `open_body_reader(relative_path)`：

- 复用现有路径穿越、符号链接和普通文件检查。
- 返回 `BufReader<File>` 或等价的安全 reader。
- 不把完整 Body 读入 `Vec<u8>`。
- inline Body 使用 `Cursor<&[u8]>`，保持同一解析接口。

读取包装器同时负责：

- 统计已扫描字节数，最多 `64 MiB`。
- 增量计算 SHA-256，hash scope 保持 `decodedBody`。
- 持续校验 UTF-8 边界，EOF 时不能残留不完整字符。
- 不把读取内容写入日志或错误详情。

### 8.2 流式解析

使用 `serde_json::Deserializer` 配合自定义 `DeserializeSeed`：

- 只遍历 JSON token，不把完整文档构造为 `Value`。
- 无关对象字段和数组元素通过 `IgnoredAny` 跳过。
- 只在命中目标路径时物化目标子树；超过单值预算后只构建结构摘要，不再保存完整值。
- 同一批路径构建路径树，尽量单次扫描 Body。
- 共享前缀合并遍历；exact 路径与通配符同时命中同一子树时，只物化该交集子树。
- 文档必须被完整消费并调用 `Deserializer::end()`；尾部错误不能让此前命中的字段变成部分成功。
- 显式限制 JSON 深度，`MAX_JSON_DEPTH=128`；深度超限返回 `JSON_TOO_DEEP`，details 包含 `maxDepth`。

### 8.3 异步执行

- Body reader 创建后，把解析、脱敏、摘要构建和 hash 计算整体放进 `tokio::task::spawn_blocking`。
- 数据库查询仍沿用现有 `with_db`。
- `get_session_fields` 逐项处理时累计总扫描预算，不把 20 个大 Body 同时展开为内存任务。
- 批量中的单个 session 超预算时，只让该项返回错误，不拖垮整批。

### 8.4 匹配和输出预算

扫描过程中必须即时执行预算，不能等最终 JSON 序列化时才发现：

- 单目标值最多物化 `64 KiB`；超限后切换为结构摘要。
- 单路径最多返回 `256` 个匹配；超限后继续消费文档但不再保存匹配值，并标记 `resultLimit`。
- 单次工具结果最多 `1 MiB`；达到预算后停止新增字段结果。
- `valueSummary` 最多 `4 KiB`、`32` 个 key。

错误映射：

- 单 Body 扫描超过 `64 MiB`：`BODY_TOO_LARGE`，details 包含 `reason="scanLimit"` 与 `scanLimitBytes`。
- 批量累计扫描超过 `256 MiB`：当前会话项返回 `BODY_TOO_LARGE`，details 包含 `reason="batchScanLimit"` 与 `batchScanLimitBytes`。
- 单值、匹配数或结果预算截断：保留成功结果并设置 `truncatedReasons` 包含 `resultLimit`。
- 单次工具总响应仍超过 `1 MiB`：返回 `RESULT_TOO_LARGE`。

## 9. 预算与限制

| 预算 | 值 | 目的 |
|---|---:|---|
| 单 Body JSON 扫描上限 | `64 MiB` | 与解码 Body 上限一致，防止无界 CPU/IO；仍作防御性兜底 |
| 批量总扫描上限 | `256 MiB` | 防止 20 个 session 最坏扫描约 `1.28 GiB` |
| 单目标值返回上限 | `64 KiB` | 防止一个巨大节点耗尽上下文 |
| 单路径匹配数 | `256` | 防止 `[*]` 无界收集 |
| 结构摘要 | `4 KiB` / `32` keys | 让 Agent 能继续下钻，同时控制 token |
| 单次路径数量 | `20` | 保持现有契约 |
| 单次工具总响应 | `1 MiB` | 沿用 Agent Access 响应上限 |
| 普通分页请求上限 | `256 KiB` | 不因本功能改变普通分页语义 |
| JSON 深度 | `128` | 防止深度攻击和递归栈风险 |

说明：正常 session Body 在抓包阶段已经受 wire/解压上限约束，通常不会超过 `64 MiB`；该上限仍必须保留，因为解压失败会回退原始字节，历史数据或导入数据也可能异常。

## 10. 脱敏与安全

流式提取不能绕过现有脱敏规则。

1. 目标节点内部递归脱敏，复用现有 `Redactor`。
2. 抽出 `redact_object` 中针对单个命名字段的逻辑，供旧路径和流式路径共同调用，避免 Secret / Identifier / PII 行为漂移。
3. 目标 key 本身敏感时：
   - 标量按 `redact_scalar` 返回 `[REDACTED]` 或伪名；
   - 对象和数组整体替换为 `[REDACTED]`。
4. 路径经过敏感祖先字段时不能继续深入：
   - 路径在该字段终止：按上述单字段规则返回；
   - 路径继续向字段内部深入：按未找到处理。
5. `redact_json_value` 必须使用目标节点的真实路径，包括通配符命中的实际 key 与数组索引。
6. 跳过无关子树时，不能把其内容写入日志、错误详情或审计记录。
7. `raw` 仍需要 `readRawBodies`，并记录脱敏状态与返回字节数。
8. 大 Body 的路径未命中时，只返回 `found=false` 和必要大小信息，不返回填充内容。

## 11. 错误与提示修正

当前 `redacted-text` 超限提示建议改用 `jsonPaths`，但 `jsonPaths` 也会因同一上限失败，提示不准确。实现后应调整为：

- 无 `jsonPaths`：`Provide target jsonPaths to extract only the needed fields; do not request the full body.`
- `$` 路径且 Body 超限：提示改用具体字段路径。
- 路径覆盖多个过大结果：提示拆分路径。
- 目标值被截断：提示先查看 `valueSummary`，再请求更具体的子路径。
- `textQuery` 与 `jsonPaths` 混用且 Body 超限：提示拆分为两次调用，并明确文本搜索的扫描上限。
- JSON 深度超过 `128`：返回 `JSON_TOO_DEEP`，提示请求更浅的路径；不要退化成 `BODY_TOO_LARGE`。
- `compare_sessions` 的 `BODY_TOO_LARGE` 保持中性，不提示改用 `jsonPaths`。

错误提示必须同时写入 `docs/API_SPEC.md` 和 Agent Skill，避免 Agent 根据旧提示继续尝试完整 Body。

## 12. 兼容性

- 不新增 MCP 工具，不改变现有工具名称和必填参数。
- 所有 `jsonPaths` 请求统一走流式实现，以消除大小边界两侧的结果差异。
- 对象通配符顺序改为源文件顺序，并在 API 文档中明确；这是统一实现带来的可见语义变化。
- 超过 `64 KiB` 的对象/数组返回 `value` + `valueSummary` 新结构，不再返回截断 JSON 字符串。
- 新增响应字段保持增量兼容；不删除现有字段。
- 老版本客户端即使忽略新增元数据，仍能读取 `jsonPaths[]`。

## 13. 测试计划

### 13.1 功能

- 构造大于 `8 MiB` 的 JSON，在目标字段前后放置大填充字段，提取中间目标节点。
- 验证响应不包含填充内容，`returnedBytes` 远小于 `decodedSizeBytes`。
- 验证对象 key、方括号 key、数组索引、通配符和多个路径。
- 验证对象通配符按源顺序返回。
- 验证重复 key 使用最后一个值。
- 验证目标节点内 token、邮箱、设备 ID 等字段仍被脱敏。
- 验证敏感祖先字段不能被绕过。
- 验证超过 `64 KiB` 的对象/数组返回 `valueSummary`，且 key 数量、类型和数组长度正确。
- 验证 Agent 可通过摘要中的子 key 继续请求更深路径。
- 验证 `get_session_fields` 对同一大 Body 可用。
- 验证 `raw=true` 的权限与审计路径。

### 13.2 边界与完整性

- 超过 `64 MiB` 返回 `BODY_TOO_LARGE`。
- 批量总扫描超过 `256 MiB` 时，后续项单独返回预算错误。
- 非法 JSON、截断 JSON、非 UTF-8 Body。
- `captureTruncated=true` 且 JSON 不完整时，不返回部分字段。
- `captureTruncated=true` 但字节恰好完整 JSON 时，结果保留 `captureLimit`。
- 找不到路径、空数组、越界索引、多个通配符命中。
- 单目标值超过 `64 KiB`、单路径匹配超过 `256`、总结果超过 `1 MiB`。
- `jsonPaths` 与 `textQuery` 混用于超大 Body。
- 深度超过 `128` 的 JSON。

### 13.3 回归与性能

- 现有 `jsonPaths`、`textQuery`、表单参数和分页测试全部通过。
- 对 `<= 8 MiB` 和 `> 8 MiB` 的目标字段提取结果做语义等价测试，除已声明的通配符顺序变化外应一致。
- `compare_sessions` 超限错误中不包含 `jsonPaths` 建议。
- MCP 工具 schema 与 `docs/API_SPEC.md` 一致。
- Skill 和帮助文档测试通过。
- 解析任务确实运行在 `spawn_blocking`，并在 tokio 运行时压力测试中不阻塞其他简单工具调用。

## 14. 文档与 Agent 指引同步

实现时必须同步更新：

- `docs/API_SPEC.md`：模式、预算、顺序、重复 key、错误码与响应字段。
- `docs/MCP_AGENT_SKILL_ARCHITECTURE.md`：流式提取、结构摘要与脱敏边界。
- `crates/mcp-server/src/server.rs`：工具描述中加入“必须优先使用 jsonPaths，禁止为单个字段分页完整 Body”。
- `apps/desktop/src-tauri/resources/agent-skill/aiproxy/SKILL.md`：工作流、禁止项与截断后的下钻方式。
- `apps/desktop/user-guides/zh-CN/agent-access.md`：中文用户指南。
- `apps/desktop/user-guides/en/agent-access.md`：英文用户指南。
- `docs/README.md`：如新增独立文档，补充索引。

## 15. 实施阶段

### 阶段 1：统一提取语义

- 所有 `jsonPaths` 改走流式提取。
- 固定对象通配符顺序、重复 key 和 `viewSizeBytes` 语义。
- 补齐 <= 8 MiB 与 > 8 MiB 的等价性测试。

### 阶段 2：截断摘要与安全

- 实现 `valueSummary`。
- 抽取并复用单命名字段脱敏逻辑。
- 固定真实路径、敏感祖先、UTF-8 和 capture truncated 行为。

### 阶段 3：资源预算

- 增加 `BodyStore` reader API。
- 解析移入 `spawn_blocking`。
- 加入单值、匹配数、批量总扫描、总响应和深度预算。

### 阶段 4：Agent 指引与文档

- 更新 MCP 工具描述。
- 更新内置 Skill 和中英文帮助文档。
- 修正 `BODY_TOO_LARGE` 提示，保持 `compare_sessions` 提示中性。

### 阶段 5：验证

- 运行 MCP Rust 测试。
- 运行 `pnpm --filter @aiproxy/desktop typecheck`、相关 lint 和文档测试。
- 使用真实 `app.launch` 会话验证只返回目标节点或结构摘要。

## 16. 验收标准

1. 对 `decodedSizeBytes=9084082` 的 `app.launch` 响应，调用 `jsonPaths=["$.local_premade_wizard_config_rc"]` 成功返回目标节点或其 `valueSummary`。
2. 响应 `returnedBytes` 显著小于 `decodedSizeBytes`，且不包含其他大字段内容。
3. 目标节点内敏感字段按现有 Secret / Identifier / PII 规则脱敏。
4. 敏感祖先不能被路径绕过。
5. 目标节点超限时，Agent 能从 `valueSummary` 获取子 key 并继续下钻。
6. 所有 `jsonPaths` 请求使用同一顺序、重复 key 和 `viewSizeBytes` 语义。
7. `get_session_fields` 同样支持大 Body，并受批量总预算约束。
8. 解析在 `spawn_blocking` 中执行，不阻塞 tokio 运行时。
9. 不完整或非 UTF-8 JSON 不会返回部分字段。
10. 未提供 `jsonPaths` 的大 JSON 仍不会返回完整 Body，并给出准确的下钻提示。
11. MCP 工具说明和内置 Skill 明确要求 Agent 按需提取，禁止为已知字段分页读取完整 Body。
12. 所有现有测试与新增边界测试通过。
