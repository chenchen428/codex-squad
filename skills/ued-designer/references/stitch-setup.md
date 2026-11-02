# Stitch 接入与认证恢复

仅在用户选择 UED 且当前宿主缺少 Stitch 工具或调用返回认证错误时读取。配置完成以真实只读调用为准，不以“已填配置”或网页已登录为准。

## 先复用现有连接

发现当前宿主的 Stitch MCP 工具，优先读取用户指定项目；没有指定项目时可调用 `list_projects`，空列表也是连通成功。已连通就返回设计流程，不要求重复登录或重新生成密钥。不要将用户已有配置、凭据 helper 或 Google Cloud 项目替换成插件自带配置；插件不内置账号或密钥，也不自动注册第二个 Stitch 服务。

## 用户完成 Google 登录

请用户打开 [Stitch](https://stitch.withgoogle.com/)，使用自己的 Google 账号登录并确认可进入项目页。登录、验证码、账号选择及授权由用户完成。不要索取密码、验证码或让用户把 API Key 贴进对话。

提示示例：“请先在 Stitch 完成 Google 登录。完成后我们再按你的 Codex 客户端配置 MCP；网页登录和 MCP 授权是两步。”

## 引导配置 MCP

按 [Stitch 官方 Setup & Authentication](https://stitch.withgoogle.com/docs/mcp/setup) 的当前说明选择认证方式。官方端点为 `https://stitch.googleapis.com/mcp`；支持 API Key 和 OAuth。不要假设网页登录的 cookie 可直接用于 MCP，也不要把别的客户端 JSON 原样写入 Codex TOML。

### Codex 的 API Key 配置示例

用户在 Stitch Settings 的 API Keys 区域自行创建并保存密钥。把密钥交给本机安全凭据机制，以下只引用环境变量名，不把实际值写入技能、代码库、报告或截图。

如尚无同名配置，可引导用户在其 Codex 配置中合并：

```toml
[mcp_servers.stitch]
url = "https://stitch.googleapis.com/mcp"
env_http_headers = { "X-Goog-Api-Key" = "STITCH_API_KEY" }
```

`STITCH_API_KEY` 必须在运行 Codex 的宿主进程中可见；在一个终端导出不代表桌面 App 能读取。已有 credential helper 或安全凭据配置时继续使用，不要求改为环境变量。配置字段以 [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp) 和当前客户端支持为准；上例仅为配置说明，不会自动写入或覆盖本机设置。

### 需要 OAuth 时

按同一份 Stitch 官方文档由用户完成 Google Cloud 的用户/应用认证和项目选择，使用文档要求的授权头与项目头；短期 token 到期需刷新。不能把 `codex mcp login stitch` 当作任意 Stitch 环境都可用的登录捷径。需要开通服务、改变 IAM 权限或安装依赖时，先说明具体项目和动作，不能静默替用户创建项目、赋权或更换认证方式。只协助当前缺失步骤，不复制完整 Cloud 初始化教程。

## 连通验证和恢复

用户按客户端提示刷新 MCP 连接；不为此强制重启正常 Codex。工具未在当前会话出现时说明需要客户端刷新或新会话，不能声称现有会话已自动热加载。

- 调用 `list_projects`，或读取用户指定的项目，成功后回到 UED 技能。只回报“已连通”与必要的项目引用，不回传无关项目清单。
- `401/UNAUTHENTICATED`：区分 Key/短期 token/宿主环境未载入，请用户在本机核对或刷新，不打印认证头。
- `403/PERMISSION_DENIED`：核对账号和目标项目权限；不自动新建账号、赋权或切换项目。
- 工具不存在、网络错误与权限错误分别报告。修复后做一次只读验证；仍失败保留错误类别，继续可独立完成的信息架构与本地设计系统整理，未调用成功不标记为 Stitch 出稿。

本指引核对于 2026-10-22。官方流程或客户端字段变化时，以当时文档与实际工具回执为准。
