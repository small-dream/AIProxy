# Rewrite 功能升级计划

## 目标

把 Rewrite 从“能改包的基础功能”升级为“用户敢用、好配、能验证、可排查”的核心调试能力。

核心体验目标：

- 用户能快速从抓到的请求创建规则。
- 用户能明确知道规则是否命中、改了哪里。
- 用户能做字段级改写，而不是只能整段替换。
- 用户能管理越来越多的规则，不会失控。
- 用户不会因为无效配置或规则冲突而困惑。

## 优先级原则

1. 先解决信任问题：用户必须知道 Rewrite 有没有生效。
2. 再解决创建效率：从真实请求一键创建规则。
3. 再增强改写能力：支持 JSON 字段、状态码、Cookie 等高频场景。
4. 最后做高级能力：正则、变量、表达式、复杂条件。

## P0：可解释性与基础正确性

### 1. Rewrite 命中日志 — 已落地

优先级：P0

当前最大问题是用户不知道规则有没有命中。需要在每条 Session 中展示 Rewrite 执行记录。

功能范围：

- 显示命中的 Rewrite 规则名称、ID、类型。
- 显示执行阶段：request / response。
- 显示执行结果：success / skipped / failed。
- 显示失败原因，例如目标 URL 无效、Header 值非法、Body 过大。
- 支持按规则查看命中次数。

验收标准：

- [x] 用户打开任意 Session，可以看到该请求是否经过 Rewrite。
- [x] 每条命中的规则都有明确执行状态。
- [x] 规则失败时能看到可读错误原因。

落地说明：

- 代理运行时生成 `RewriteTrace`。
- SQLite 持久化到 `rewrite_runs / rewrite_run_entries`。
- 前端通过 `list_rewrite_session_trace` 在 Automation 标签页懒加载展示。

### 2. 改写前后 Diff — 已落地

优先级：P0

Rewrite 的核心价值是“改了什么”。必须提供前后对比。

功能范围：

- Header Diff：新增、删除、修改。
- Query Diff：新增、删除、修改。
- Body Diff：原始内容 vs 改写后内容。
- Redirect Diff：原 URL vs 目标 URL。
- 在 Session 详情中展示 Rewrite 前后变化。

验收标准：

- [x] 用户可以清楚看到每条规则导致的变化。
- [x] Header / Query / URL 的变化能结构化展示。
- [x] Body 支持文本预览 Diff，JSON Diff 后续增强。

### 3. 无效组合提示 — 已落地

优先级：P0

当前 Query 和 Redirect 主要作用在请求阶段，但 UI 允许选择响应阶段，容易造成“配置了但没生效”的困惑。

功能范围：

- 响应阶段禁用 Query Rewrite。
- 响应阶段禁用 Redirect Rewrite。
- 不支持的组合给出明确提示。
- 保存前校验规则是否可执行。

验收标准：

- [x] 用户不能保存明显无效的 Rewrite 配置。
- [x] 已有无效规则展示 warning。
- [x] 文案明确说明为什么不可用。

## P1：从真实请求快速创建规则

### 4. 从 Session 一键创建 Rewrite — 已落地首版

优先级：P1

用户最自然的路径不是去规则页手填，而是在抓包列表里看到一条请求后直接创建规则。

功能范围：

- Session 右键增加“创建 Rewrite 规则”。
- 自动带入 URL Pattern。
- 自动带入 HTTP Method。
- 自动选择 request / response 阶段。
- 从 Header 创建 Header Rewrite。
- 从 Query 参数创建 Query Rewrite。
- 从 Body JSON 字段创建 Body Rewrite。
- 创建后跳转到 Rules / Rewrite 编辑态。

验收标准：

- [x] 用户能在 3 步内从一条请求创建可用规则。
- [x] 常见字段自动填入，不需要手动复制 URL、Header、参数名。
- [x] 创建后的规则默认可保存并立即生效。

落地说明：

- Session 右键菜单新增 `Create Rewrite Rule`。
- 当前首版自动生成 Header Rewrite 草稿，并带入 URL / Host / Path / Method。
- Header、Query、Body 字段级上下文菜单创建可作为后续增强。

### 5. Rewrite 规则测试器 — 已落地

优先级：P1

用户保存前应该能测试规则是否会命中。

功能范围：

- 输入 URL、Method、Stage。
- 显示是否命中当前规则。
- 显示预计执行动作。
- 支持用当前 Session 作为测试样本。
- 显示不命中的原因。

验收标准：

- [x] 用户保存前能确认规则是否匹配。
- [x] 不命中时能看到原因，例如 Method 不匹配、URL 不匹配、Stage 不匹配。

### 6. 高频模板 — 已落地首版

优先级：P1

降低普通用户使用门槛。

模板范围：

- 添加调试 Header。
- 设置 Authorization。
- 删除缓存 Header。
- CORS 快捷修复。
- Query 参数切环境。
- Redirect 到 staging。
- Mock JSON 响应。
- 修改登录态字段。

验收标准：

- [x] 用户可以从模板创建规则。
- [x] 模板创建后字段完整、可直接保存。
- [x] 模板文案面向场景，而不是面向技术字段。

落地模板：

- Debug header
- Disable cache
- Env query
- Staging redirect
- Mock JSON

## P2：精细化改写能力

### 7. JSON 字段级 Body Rewrite

优先级：P2

整段替换 Body 太粗，字段级改写是高频刚需。

功能范围：

- 支持 JSONPath 选择字段。
- 支持设置字段值。
- 支持删除字段。
- 支持新增字段。
- 支持 number / string / boolean / null 类型。
- JSON 解析失败时展示错误。

示例：

```json
{
  "$.data.user.isVip": true,
  "$.code": 0,
  "$.message": "success"
}
```

验收标准：

- 用户能只修改响应 JSON 的一个字段。
- 不需要复制整个响应 Body。
- 修改后 Session 中能看到 JSON Diff。

### 8. Status Code Rewrite

优先级：P2

测试错误态、降级态、鉴权态时非常常用。

功能范围：

- 支持修改响应状态码。
- 可搭配 Body Rewrite 使用。
- 可搭配 Header Rewrite 使用。

验收标准：

- 用户可以把响应改成 200 / 401 / 403 / 500。
- Session 中展示状态码改写记录。

### 9. Cookie Rewrite

优先级：P2

Cookie 是 Web 调试常见对象，应该从 Header 中独立出来。

功能范围：

- 新增 Cookie。
- 修改 Cookie。
- 删除 Cookie。
- 支持 request Cookie。
- 支持 response Set-Cookie。

验收标准：

- 用户不需要手写完整 Cookie Header。
- Cookie 变更能结构化展示。

## P3：规则治理能力

### 10. 规则复制、分组、批量启停

优先级：P3

规则多起来以后，管理效率比单条配置更重要。

功能范围：

- 复制规则。
- 规则分组。
- 批量启用 / 停用。
- 按分组搜索。
- 分组折叠。
- 规则备注强化。

验收标准：

- 用户能快速复用已有规则。
- 用户能按项目、环境、场景组织规则。

### 11. 冲突检测

优先级：P3

多条规则可能改同一个 Header、Query 或 Body 字段，需要提醒用户。

功能范围：

- 检测同阶段、同匹配范围、同目标字段的规则。
- 展示潜在冲突。
- 显示最终执行顺序。
- 根据 priority 解释哪条后生效。

验收标准：

- 用户保存规则时能看到潜在冲突。
- 用户能理解最终哪条规则会影响结果。

### 12. 临时规则与命中统计

优先级：P3

调试规则经常是临时的，忘记关闭会制造问题。

功能范围：

- 规则自动过期。
- 规则启用倒计时。
- 命中次数统计。
- 最近命中时间。
- 一键清理未命中规则。

验收标准：

- 用户可以创建 30 分钟后自动关闭的规则。
- 用户能看到规则是否真的被使用过。

## P4：高级能力

### 13. 正则与变量

优先级：P4

面向高级用户，提升表达能力。

功能范围：

- URL 正则匹配。
- 正则捕获组替换。
- 内置变量：timestamp、uuid、random、date。
- 环境变量：dev / staging / prod。
- 引用请求字段：host、path、query、header。

验收标准：

- 用户可以用捕获组动态构造目标 URL 或字段值。
- 变量在保存前可预览解析结果。

### 14. 条件表达式

优先级：P4

用于复杂场景，但不应该影响普通用户使用。

功能范围：

- Header 条件。
- Query 条件。
- Body JSON 条件。
- Status Code 条件。
- Content-Type 条件。

验收标准：

- 用户可以表达“只有当 `$.code == 401` 时才改写”。
- 条件不满足时命中日志显示 skipped reason。

## 推荐里程碑

### Milestone 1：让用户敢用 Rewrite

包含：

- Rewrite 命中日志。
- 改写前后 Diff。
- 无效组合提示。

目标结果：

- 用户能确认规则是否生效。
- 用户能定位为什么没生效。
- Rewrite 从黑箱变成可解释工具。

### Milestone 2：让用户快速创建 Rewrite

包含：

- 从 Session 一键创建规则。
- Rewrite 规则测试器。
- 高频模板。

目标结果：

- 用户不需要手动复制 URL、Header、Query。
- 调试路径从“配置规则”变成“基于真实请求生成规则”。

### Milestone 3：让 Rewrite 真正好用

包含：

- JSON 字段级改写。
- Status Code Rewrite。
- Cookie Rewrite。

目标结果：

- 覆盖大多数前端、移动端、QA 联调场景。
- Body Rewrite 从粗粒度替换升级为精准修改。

### Milestone 4：让规则规模化可管理

包含：

- 复制、分组、批量启停。
- 冲突检测。
- 临时规则。
- 命中统计。

目标结果：

- 用户能长期维护规则集。
- 团队和复杂项目中也能保持可控。

## 北极星指标

- 从 Session 创建一条可用 Rewrite 的平均时间。
- Rewrite 规则保存成功率。
- Rewrite 规则命中可解释率。
- 用户查看 Diff 的比例。
- 创建后 10 分钟内成功命中的规则占比。
- 因 Rewrite 配置错误导致的失败率。
- 临时规则自动关闭使用率。

## 第一阶段建议立即做

以下 3 个需求已完成首版：

1. Rewrite 命中日志。
2. 改写前后 Diff。
3. 从 Session 一键创建 Rewrite。

这三个会直接改变用户体感：从“我配置了一个规则，不知道有没有用”，变成“我基于这条请求创建规则，并且马上看到它改了什么”。
