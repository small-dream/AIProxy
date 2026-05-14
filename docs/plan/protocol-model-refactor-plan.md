# P0 协议模型重构实施计划

## 背景

当前 Session 只有 `protocol` 字段，实际混用了 URL scheme、展示标签和未来 HTTP version 语义。HTTP/2、gRPC、HTTP/3 都需要更清晰的协议模型，因此先在不改变现有 `protocol` 兼容字段的前提下补齐结构化字段。

## 字段定义

新增字段写入 Session summary：

- `scheme`：应用层 URL scheme，当前为 `http` / `https`。
- `httpVersion`：HTTP 版本，当前真实捕获固定为 `1.1`，允许导入 / 测试数据出现 `2` / `3`。
- `transportProtocol`：传输层协议，当前为 `tcp`，HTTP/3 预留 `quic`。
- `applicationProtocol`：应用协议，当前为 `http` / `websocket`，为 `grpc` / `grpc-web` 预留。

旧字段 `protocol` 保留，不改名、不删除、不改变现有调用方的基本语义。

## 实施范围

- Rust `ProxySessionSummary`、SQLite `session_summaries`、Tauri payload 和 shared-types `SessionSummary` 增加结构化协议字段。
- 后端统一从当前 `protocol` 和 `url` 推导协议元数据。
- WebSocket 会话继续保留旧 `protocol = "ws" | "wss"`，同时设置 `applicationProtocol = "websocket"`。
- 前端新增协议 helper，Inspector 中协议展示、HTTP version、keep-alive、SSL / TLS 判断优先使用新字段，缺失时回退旧 `protocol`。
- HAR 导出使用 `httpVersion` 生成 `HTTP/{version}`。

## SQLite 策略

开发阶段不做旧 SQLite 兼容迁移。新 schema 直接包含新增列；已有开发库如果缺列，清空或删除本地开发数据库后重建。

## 非目标

- 不实现 HTTP/2 ALPN、frame 解析或多 stream 捕获。
- 不实现 Protobuf / gRPC 解码。
- 不实现 HTTP/3 / QUIC 捕获。
- 不重做 Sessions 列表视觉设计。

## 验收

- 新捕获 / Compose / 导入 Session 都能得到结构化协议字段。
- 旧前端缓存或旧导入数据缺少新字段时，前端 helper 能回退旧 `protocol`。
- WebSocket Inspector 仍进入 Messages 视图。
- 现有 `protocol` 字段仍可用于兼容导出、规则和旧 UI 逻辑。
