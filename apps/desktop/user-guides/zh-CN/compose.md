# 请求构造（Compose）使用指南

Compose 是 AIProxy 内置的 HTTP 请求构造器，类似精简版 Postman。你可以在不离开桌面工作台的情况下，手动拼一个请求发出去，立即看到响应。

## 功能定位

Compose 的请求是**直连目标服务器**的，**不经过代理规则**——也就是不受 [DNS 映射](./dns-mapping.md)、[Rewrite](./rewrite-rules.md)、[映射](./map-rules.md)、[脚本](./script-rules.md)、[断点](./breakpoints.md)、[限速](./throttling.md) 的影响。它适合直接验证某个接口的真实返回，而不是测试代理链路。

> 想测试「请求经过代理规则后的样子」，应该走正常抓包流程，而不是 Compose。

## 入口位置

1. 在左侧导航栏点击 **构造请求（Compose）**

页面上下分栏：上方是请求编辑器，下方是响应预览，中间分隔线可拖动调整比例。

顶部工具栏支持：

- **环境选择器**：选择当前环境和全局变量；齿轮图标打开环境管理
- **导入 cURL**：粘贴带 `http(s)` URL 的 cURL 命令并转换为请求
- **保存到集合**：把当前构造内容保存为集合项
- **复制 cURL**：按当前请求生成 cURL 命令

你也可以在 [Sessions](./sessions.md) 里右键某条请求 → **重复请求（Repeat）**，会跳到 Compose 并自动带入该请求的参数。

## 构造请求

### 方法与 URL

- **HTTP 方法**：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS（默认 GET）
- **URL 输入框**：填完整 URL；在 URL 框内按 **Enter** 直接发送

### Headers

用键值对表格编辑请求头，可动态增删行。

### Query 参数

从当前 URL 自动解析出 Query 参数，用键值对表格编辑；改完会回写到 URL。

### Body

通过顶部的切换选择 Body 类型：

| 类型 | 说明 |
|---|---|
| none | 无 Body |
| form-data | `multipart/form-data` 表单；文本用键值对编辑，文件用 **附加文件** 添加（发送时自动生成 boundary 和 Content-Type） |
| x-www-form-urlencoded | URL 编码表单，键值对编辑 |
| raw | 原始文本 Body |

**raw** 模式可选语言（决定 Content-Type）：

| 语言 | Content-Type |
|---|---|
| Text | `text/plain` |
| JSON | `application/json` |
| XML | `application/xml` |
| HTML | `text/html` |
| JavaScript | `application/javascript` |

> 附件只能从系统允许的目录中选择（下载、图片、视频、桌面或文档）。应用在发送时才从磁盘读取文件；包含文件部分的 cURL 命令（`-F 名字=@文件`）无法直接导入——先去掉这些部分完成导入，再手动附加文件。环境变量可替换字段名和值，但不会替换附件的文件 token。

## 发送与响应

点 **发送（Send）** 发出请求（URL 为空或发送中时按钮禁用）。响应区会复用与 Sessions 相同的检视器，提供：

- **Overview**：状态码、耗时、大小、客户端 / 服务器连接信息
- **Headers**：响应头
- **JSON / JSON Text**：树形或文本格式的 JSON（支持搜索）
- **Raw / Text**：原始或纯文本响应
- **Preview**：图片等媒体的预览
- **Timing**：各阶段耗时

请求失败时会显示错误信息。

## 与 Sessions 的关系

Compose 发出的请求会**以会话形式插入 Sessions 列表**，可以像普通抓包一样回头检视、搜索、[对比](./session-compare.md)。所以 Compose 既是构造工具，也是一种「主动发起并记录」的抓包方式。

## 当前版本的限制

- **不经过代理规则**（直连目标）
- **没有独立请求历史**
- Body 超过 **20 MB** 会截断

## 常见问题

### Q: 为什么 Compose 发的请求没应用我的 Rewrite / DNS 映射？

Compose 是直连请求，刻意绕过代理规则。要测试代理规则效果，请用浏览器 / 客户端走系统代理正常抓包。

### Q: Compose 发的请求会出现在 Sessions 里吗？

会。每次发送都会作为一条会话插入列表，方便后续检视和对比。

### Q: 想带环境变量发请求怎么办？

在 Compose 顶部选择环境后，URL、Header、Raw Body 和表单字段中的 `{{var}}` 会在发送时替换。当前环境和全局变量同名时，当前环境优先。

### Q: 怎么快速重发某条抓到的请求？

在 Sessions 右键该请求 → **重复请求**，会带入 Compose 直接修改重发。

### Q: 能保存构造好的请求反复用吗？

可以——点击工具栏的 **保存到集合**，把当前构造内容存进[集合](./collections-and-environments.md)。也可以在 Sessions 右键某条请求 → **保存到集合**，之后在集合里随时调用。
