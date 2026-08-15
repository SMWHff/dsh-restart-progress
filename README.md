# dsh-restart-progress

DeepSeek Harness (DSH) Web 重启体验插件：**页内遮罩 + 分离式重启脚本 + 重启完成自动报告**，让服务重启全程可视、自动、可随时退出。

## 功能

- 🌀 **提前显示遮罩**：执行重启脚本的瞬间（服务还没断），当前页面 2 秒内出现全屏转圈遮罩，不等断线。
- 🔄 **自动刷新**：服务恢复且重启任务收尾完成后，页面自动刷新回到 DSH。
- 🔔 **自动报告**：重启完成后，脚本自动向发起重启的会话发送「已重启」消息，agent 被唤醒并向用户报告。
- ✕ **随时退出**：遮罩右上角大叉叉按钮，或按 `Esc`，立即退出遮罩并停止自动刷新。
- 🛡️ **防死循环**：只有在「服务在线 + 重启任务收尾完成」双条件满足时才刷新页面，杜绝 reload 死循环。
- 🚀 **分离式执行**：真正的杀旧+启新动作交给 Windows 计划任务执行，脱离 dsh 进程树——即使由 agent 在会话内触发重启，也不会把执行脚本自己杀死（`taskkill /T` 杀不到任务体）。

## 安装

### 1. 安装插件

```sh
dsh plugin --profile web add "github:<你的GitHub用户名>/dsh-restart-progress"
```

安装后重启一次 dsh web 使插件注入生效。

### 2. 配置重启脚本

把 `scripts/restart-dsh-web.ps1` 复制到本机（例如 `~/.dsh/scripts/`），并按机器实际情况修改脚本顶部三个硬编码路径：

```powershell
$logDir = 'C:\Users\<你的用户名>\.dsh\logs'
$node   = 'C:\Program Files\nodejs\node.exe'   # node.exe 实际路径
$bin    = '...\node_modules\@deepseek-ai\dsh\lib\bin.js'  # dsh bin.js 实际路径
```

（`$env:DSH_HOME`、`-WorkingDirectory` 同理替换为你的用户目录。）

### 3. 使用

```powershell
# 在 dsh web 会话中（agent 可执行），或任意终端：
& ~/.dsh/scripts/restart-dsh-web.ps1
```

此后：当前页面立即转圈 → 服务重启 → 页面自动刷新 → agent 自动报告「已重启」。

## 工作原理

```
restart-dsh-web.ps1（外层，1 秒内退出）
 ├─ 1. 写 pending 标志（含发起会话 ID）→ 前端轮询到 → 立即显示遮罩
 ├─ 2. 生成 restart-body.ps1（杀旧+启新+健康检查+会话通知+清理）
 └─ 3. 注册一次性计划任务 dsh-web-restart 并立即触发（任务体脱离进程树）

计划任务 restart-body（独立进程树）
 ├─ 等 8 秒（给外层收尾）
 ├─ taskkill /T 杀旧 dsh web（含 MCP 子进程）
 ├─ Start-Process 启动新 dsh web
 ├─ 健康检查轮询 3080 端口（最多 60 秒）
 ├─ POST /api/session.prompt 向发起会话发送「已重启」（重试 8 次）
 └─ 清 pending 标志 + 自删任务

前端插件（当前页面内）
 ├─ 每 2 秒轮询 GET /api/restart-progress/status
 ├─ pending=true → 显示遮罩（右上角 ✕ / Esc 可退出）
 ├─ 服务离线 → 遮罩显示「等待服务恢复」
 └─ 服务在线 + pending=false 连续 3 次 → 自动刷新页面
```

## 踩坑记录（Windows PowerShell 5.1）

1. PS 5.1 按 ANSI(GBK) 读无 BOM UTF-8 脚本 → 脚本内禁止裸中文，中文用 base64 传输。
2. `Invoke-WebRequest` string body 按 Latin-1 编码 → 发 JSON 用 UTF-8 字节数组。
3. `schtasks /Create` + `/Run` 后任务可能未真正执行 → 触发后 5 秒校验任务状态。
4. 新服务端口监听 ≠ API 路由就绪 → 会话通知带 8 次重试。

## 许可证

MIT
