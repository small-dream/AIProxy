# M3.5 三端发布冒烟记录

这份清单用于 `0.1.20` 候选版本。它描述需要在对应原生宿主机完成的验证，不由 CI 伪造通过；每个平台都应在发布 PR 中附上日期、构建产物、系统版本和日志路径。

## 平台记录

| 平台 | 宿主机/版本 | 产物路径 | 执行人 | 日期 | 结果 | 日志/截图 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS |  |  |  |  | ☐ |  |
| Windows |  |  |  |  | ☐ |  |
| Linux |  |  |  |  | ☐ |  |

## 每个平台必须完成

- ☐ 安装对应 bundle，并确认应用版本、build number 和 commit hash。
- ☐ 启动应用，生成或检测根证书；证书安装失败时记录用户可执行的错误上下文。
- ☐ 启动 HTTPS 代理并捕获一个 HTTP/1.1 请求和一个 HTTP/2 请求（不支持 HTTP/2 的环境记录回退结果）。
- ☐ 在 Session Inspector 查看普通 headers、HTTP/2 pseudo headers、trailers、状态码和 body。
- ☐ 验证 Map Remote：目标带 base path、HTTPS → HTTP 或 HTTP → HTTPS 的目标地址均不重复路径、不错误发起 TLS。
- ☐ 若配置上游代理，分别验证直连绕行和失败时不静默回退直连；至少覆盖 HTTP 或 HTTPS 代理，具备条件时覆盖 SOCKS5。
- ☐ 启用请求/响应节流，确认两侧 trace、延迟和失败响应可解释。
- ☐ 导出 HAR，重新导入并确认 HTTP version、trailers、encoded body 和空 body 不生成非法数据。
- ☐ 正常关闭代理，确认系统代理恢复；再执行一次异常退出恢复验证。
- ☐ 打开 `Settings -> Software Updates`，验证更新检查结果；配置 updater 时完成安装并重启验证。

## 失败处理

任一必选项失败时，候选版本不得标记为稳定版。保留 HTTP/2 回退开关，附上 `show_log_file` 输出和失败 session/trace；协议失败阻止 M4 Beta 进入主线。
