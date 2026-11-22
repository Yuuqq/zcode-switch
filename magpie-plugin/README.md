# Magpie × ZCode Switch

## English

Unofficial provider **`zcode-switch`**, separate from the community `zcode`
provider. Magpie routes/fails over between the saved accounts you explicitly
link. This package has no runtime dependencies (Node 20+ tests, Bun host).

### Install

Download `zcode-switch-magpie-plugin-<tag>.zip` or `.tar.gz` from
[Releases](https://github.com/Yuuqq/zcode-switch/releases), check its SHA-256
using `checksums-magpie-plugin-<tag>.txt`, and extract it. Then run:

```sh
magpie plugin add /abs/path/zcode-switch-magpie-plugin
```

Use an absolute path (PowerShell: `(Resolve-Path .\zcode-switch-magpie-plugin).Path`),
or `./zcode-switch-magpie-plugin` from the extracted folder's parent. Retain the
folder while using it; install a newer release's extracted folder to update.

Clone this repository, then add the **absolute local subdirectory**:

```sh
git clone https://github.com/Yuuqq/zcode-switch.git
magpie plugin add "$(pwd)/zcode-switch/magpie-plugin"
```

In PowerShell, after cloning:

```powershell
magpie plugin add (Resolve-Path .\zcode-switch\magpie-plugin).Path
```

Magpie's `internal/plugin/store.go` accepts absolute file/folder paths and its
`host.js` resolves this folder's `package.json` entry. Local plugins are used
in place, not copied: retain the checkout and `git pull` it to update, then
reload/restart Magpie. `magpie plugin add github:Yuuqq/zcode-switch` installs
the repository root (the desktop app), **not this package**. No Git-subdirectory
syntax is documented/supported by Magpie's installer; use the local path above.

In Magpie add a **ZCode Switch** provider account. Choose a named account
(email and immutable ID are displayed), all accounts, or selected IDs separated
by commas. Reload plugins after adding new snapshots. Each selected ID gets
one stable Magpie slot. Re-linking updates that reference, not a credential copy.
Remove the corresponding Magpie account to unlink it; removing the source
snapshot never silently binds its name to another account.

### Credentials and safety

- Reads only `<home>/.zcode-switch/accounts/*.json`. Home selection matches
  Rust: `ZCODE_SWITCH_HOME`, then `USERPROFILE`, then `HOME`, then OS home.
  `ZCODE_SWITCH_HOME` is the **home root**, not the accounts directory.
- Decrypts `enc:v1:` AES-256-GCM values in memory with SHA-256 of
  `ZCODE_CREDENTIAL_SECRET` (including an empty override), otherwise
  `zcode-credential-fallback:<node-platform>:<home>:<OS-username>`.
  Unix uses the OS username; Windows uses `USERNAME`, then `USER`/`LOGNAME`.
  Pass overrides to the **Magpie host's environment**, not just the installer.
- Magpie's host-managed `plugin-auth.json` contains only ID references and
  nonsecret OAuth-shaped markers. No tokens, API keys, emails, or snapshot
  contents are persisted by the plugin. The host owns locking/account routing.
- Every inference request rereads its snapshot, including locally encrypted
  nested config keys. Coding Plan keys use the Anthropic-compatible endpoint
  at `api.z.ai` or `open.bigmodel.cn`, with API-key/Bearer headers. JWT-only
  sessions use ZCode's `/api/v1/zcode-plan/anthropic/v1` endpoint and session
  headers, not the paid-key endpoint. Keys take precedence over a cached JWT.
  Cross-route redirects and arbitrary inference destinations are refused.
- Missing/unreadable snapshots, bad encryption, and expired JWTs give explicit
  errors. Refresh/sign in using ZCode Switch and update the snapshot; this
  plugin does not refresh sessions, create keys or write either application's
  credentials. Newer remote `project-key-location:v1:` records without a saved
  resolved key and team-token-only sign-ins are not imported as paid keys.
- Model discovery follows the community plugin's plan-specific provider-config
  rules via the official client-config endpoint and its HTTPS config URL,
  with a ten-minute cache and a bundled fallback (JWT fallback excludes
  GLM-5.3). These config reads carry no account credentials. Entitlement/balance
  filtering, `-Trial` lanes, automatic paid/free switching, community body/prompt
  rewriting and usage reporting are intentionally not included. A listed model
  still requires the account's entitlement; the server remains authoritative.
- **No activity reporting/simulation, telemetry events, claiming, live ZCode
  access, or writes to ZCode Switch.** Requests occur only for model discovery
  and user inference. Session request headers include the actual platform,
  OS version and locale, as the community provider does. There is no background
  sync or generated device identity. A plugin can read local secrets: install
  only trusted code, and keep snapshots and Magpie's process environment private.

MIT source licenses were checked before adapting the community model/routing
approach; see [NOTICE](NOTICE) and [LICENSE](LICENSE). This is not the entire
community plugin and does not inherit its activity/claim functionality.

### Tests

```sh
node --test magpie-plugin/test/*.test.mjs
# Optional: requires bun and a Magpie source checkout; fixtures only, no live API calls
node magpie-plugin/test/host-smoke.mjs /path/to/magpie/internal/plugin/host.js
```

Fixtures contain deliberately fake keys/JWTs, including a fixed AES-GCM test
vector for `fixture-secret`. Unit tests mock network/host calls. The host smoke
test runs the real Bun JSON-RPC host with isolated fixture state, verifies
sign-in/deduplication/load hooks, and does not send inference requests. Neither
check establishes live vendor/captcha compatibility.

## 中文

独立的非官方 **`zcode-switch`** 提供商，不接管社区 `zcode`。Magpie 负责多账号
路由与故障切换；插件只关联你明确选择的本地快照。

### 安装与选择账号

可从 [Releases](https://github.com/Yuuqq/zcode-switch/releases) 下载
`zcode-switch-magpie-plugin-<tag>.zip` 或 `.tar.gz`，按
`checksums-magpie-plugin-<tag>.txt` 校验 SHA-256 后解压，执行
`magpie plugin add /abs/path/zcode-switch-magpie-plugin`。请使用绝对路径
（PowerShell 可用 `(Resolve-Path .\zcode-switch-magpie-plugin).Path`），或在父目录
使用 `./zcode-switch-magpie-plugin`。保留解压目录，更新时安装新版解压后的目录。

也可从源码安装：

```sh
git clone https://github.com/Yuuqq/zcode-switch.git
magpie plugin add "$(pwd)/zcode-switch/magpie-plugin"
```

Windows PowerShell：`magpie plugin add (Resolve-Path .\zcode-switch\magpie-plugin).Path`。
必须使用本地子目录的绝对路径；`github:Yuuqq/zcode-switch` 指向桌面应用根目录，
不能安装这个子包。Magpie 安装器没有明确支持的 Git 子目录语法。保留克隆目录，
用 `git pull` 更新后重载/重启 Magpie。

添加 ZCode Switch 提供商账号时，可选择单个账号、全部账号或输入逗号分隔的多个
不可变账号 ID；列表显示名称、邮箱及 ID。每个来源 ID 对应一个稳定的 Magpie
账号槽位，重复关联不复制凭据。新建快照后重载插件；删除 Magpie 中对应账号即解除关联。

### 存储、安全与限制

- 只读 `<home>/.zcode-switch/accounts/*.json`。home 优先级与 Rust 相同：
  `ZCODE_SWITCH_HOME` → `USERPROFILE` → `HOME` → 系统 home。
  `ZCODE_SWITCH_HOME` 是 home 根目录，不是账号目录。
- 按 Rust 的 SHA-256 + AES-256-GCM 格式在内存解密 `enc:v1:`。支持
  `ZCODE_CREDENTIAL_SECRET`（含空字符串覆盖）；否则使用平台、home 和系统用户名
  组成的 fallback secret。环境变量必须传入运行中的 Magpie 插件宿主。
- 仅通过 `client.auth.set` 保存账号 ID 引用到 Magpie 管理的 `plugin-auth.json`，
  不保存 JWT、API key、邮箱或快照副本。不写 ZCode Switch，也不读取/修改 ZCode 实时文件。
- 每次推理重读快照。Coding Plan key 分别走 z.ai/BigModel 的 Anthropic 接口；
  只有 JWT 时走 ZCode session 接口，优先使用已保存的付费 key。拒绝跨站重定向及未知推理地址。
  账号丢失、解密失败或 JWT 过期会明确报错，请重新登录并更新快照。
  不自动刷新/创建 key；仅包含远端 key-location 或团队 token 的快照暂不支持作为付费账号。
- 模型按官方 client-config 返回的 HTTPS 配置及套餐规则列出，缓存 10 分钟，失败时
  使用内置列表（JWT fallback 不含 GLM-5.3）。配置查询不携带账号凭据。
  不包含余额过滤、`-Trial` 模型、付费/免费自动切换、社区插件的正文/提示词改写或用量查询。
  模型列表不保证账号拥有对应权益，最终以服务端为准。
- **无活动上报/模拟、遥测事件、自动领取、后台同步或随机设备标识。** 仅进行模型配置查询
  和用户发起的推理；session 推理头包含本机平台、系统版本和语言信息。
  插件能读取本机凭据，请只安装可信代码并保护快照与进程环境。

测试命令见英文部分。测试使用假 key/JWT、已知密钥加密向量和模拟宿主；可选 smoke
测试通过 Bun 运行真正的 Magpie JSON-RPC 宿主，使用隔离快照，不发送真实推理请求。
未验证真实账号、验证码或服务端兼容性。社区源码为 MIT，许可与署名见 NOTICE/LICENSE。
