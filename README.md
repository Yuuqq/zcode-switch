# Z·SWITCH (zcode-switch)

**简体中文** ｜ [English](README.en.md)

Tauri 2 桌面工具：在多个 ZCode 账号之间一键切换，自动显示额度。只换登录身份——项目、会话、设置全部共用不动。

![screenshot](docs/screenshot.png)

## 功能

- **保存 / 切换账号**：一键切换登录身份；切换前自动保全当前登录，绝不丢号；设备身份跟账号走，远程控制中继密钥跨切换保活
- **添加账号**：工具内 OAuth 登录新号（BigModel / z.ai 双入口），全程不动当前登录
- **额度展示**：账号行内联显示套餐额度与重置时间，多套餐分组
- **活动领取**：可领套餐一键领取；「自动领取」开关（默认关）定时自动检测并领取，手动操作优先
- **加密导入导出**：`.zsb` 捆绑包，PBKDF2(100k) + AES-256-GCM 口令加密
- **中英双语**：设置里一键切换 中文 / English，主窗、托盘、错误提示、CLI 输出全覆盖；首次运行按系统语言自动选择
- **托盘 / 开机自启 / CLI 自动化**

## 安全设计

- **本地存储、官方服务**：账号快照和设置保存在本地；额度与活动请求直连官方服务。手动或自动刷新活动资格时，会按官方客户端的方式向 `https://zcode.z.ai/api/v1/event/report` 发送 `app_launch` / `app_daily_active` 事件，包含用户/设备标识与客户端环境信息；不新增伪造或随机活动。
- **WebView CSP**：`script-src` 允许 `'self'`、`'unsafe-inline'`、`'unsafe-eval'` 及配置中的阿里 CDN/Aliyun 验证码脚本来源。样式允许内联及指定 CDN；图片允许 `data:`、`blob:` 和 HTTPS。连接、框架与 worker 的白名单见 `src-tauri/tauri.conf.json`；`object-src` 为 `'none'`。开发模式另允许本地 Vite HTTP/WebSocket 服务。
- **防丢号**：切换前自动保全未入库登录；文件写入走临时文件 + 原子 rename
- **路径穿越防护**：账号 id 白名单（`[A-Za-z0-9-]`），删除/读取均不可逃出账号库目录
- **加密导出**：PBKDF2-HMAC-SHA256（100k 迭代）+ AES-256-GCM，随机 salt/nonce；错密码即失败，无明文痕迹
- **凭据只在本地解密**：用于账号操作及可移植导出；导出文件凭口令加密

## 导入 / 导出

在账号菜单导出单个账号，或在设置中批量导出 / 导入 `.zsb` 文件。CLI 命令见下节。

- GUI 与 CLI 导出均要求非空白且至少 **6 个字符**的密码；导入接受任意非空白密码，兼容旧版短密码。
- 加密封装仍为版本 1（PBKDF2-HMAC-SHA256，100,000 次迭代；AES-256-GCM）。新版版本 3 载荷先在**内存中**解密源电脑的 `enc:v1:` 值，再整体口令加密。导入时用目标电脑的本地 ZCode 密钥重新加密对应字段，原本明文字段仍保持明文。无法解密本地凭据时取消导出。
- 保留账号名称、`createdAt`、凭据和 config；账号 ID 和设备身份按需重新生成，不含应用设置、项目或会话。同批次及已有名称冲突均添加后缀，重复凭据跳过。
- 仍支持版本 2 载荷：尝试使用本机密钥解密旧版内部密文；失败则原样保留并显示警告，该账号可能无法在本机使用。请在源电脑重新导出以获得可移植文件。旧版应用无法导入版本 3 载荷。
- 拒绝未知版本或不支持的加密元数据。先校验所有选中文件，再暂存账号文件；写入失败会回滚并清理新增文件。跳过重复账号不影响其余导入。这是应用层事务，不提供崩溃或断电恢复保证。

请妥善保管导出密码：同时持有文件和密码即可访问其中的凭据。

## 活动领取行为

每次验证和结果均由唯一请求标识关联，超时会取消该次待处理验证。已发出的 HTTP 请求无法撤回，服务端仍可能在超时后完成领取。

“全部领取”逐账号刷新资格，每个账号最多领取 5 个不同套餐，每次成功后重新查询，结束时汇总各账号的数量与状态。网络、HTTP 5xx、超时等临时故障最多重试 2 次，间隔 1/2 秒且重试前重新确认资格；业务错误不重试。临时错误后套餐消失、结果不确定时停止该账号，不猜测成功。

资格刷新失败会清空缓存并标为过期，自动领取不使用过期套餐。自动冷却截止时间保存于 `~/.zcode-switch/claim-cooldowns.json`（设置 `ZCODE_SWITCH_HOME` 时使用该目录），到期失效。冷却文件损坏或无法写入时暂停自动领取，修复后重启。自动模式的激活上报诊断写入 Tauri 应用本地数据目录下现有的 `logs/oauth.log` 流程日志及前端控制台，不改变上报事件。

## CLI

```
zcode-switch.exe --cli state|list
zcode-switch.exe --cli quota [--id <账号id>]
zcode-switch.exe --cli claim-preview [--id <账号id>]
zcode-switch.exe --cli capture [--name 名称]
zcode-switch.exe --cli switch --id <id> [--force] [--restart|--no-restart] [--hot <bool>|--no-hot]
zcode-switch.exe --cli kill
zcode-switch.exe --cli export --id <id> --out <a.zsb>
zcode-switch.exe --cli export-all --out <all.zsb>
zcode-switch.exe --cli import --file <file.zsb>
zcode-switch.exe --cli rename|delete|update|behavior|setpath|launch
zcode-switch.exe --cli --lang en state              # 英文输出（--lang 空格传值、可置于任意位置；默认跟 GUI 语言/系统语言）
```

CLI 密码（export / import）：优先环境变量 `ZSW_PASSWORD`（不出现在进程列表和命令历史），也可 `--password <密码>`。

## 常见问题

### macOS 弹出「麦克风 / 辅助功能 / 录屏」权限询问？

全部拒绝即可，不影响任何功能。
应用内嵌的登录等网页由系统 WebView 渲染，网页发起的请求会被透传为应用的系统权限询问；应用本体与其内嵌网页均未使用这三项能力。

## 构建

```bash
npm install
npm run tauri dev      # 开发（HMR）
npm run tauri build    # NSIS 安装包
```

Windows 优先（路径探测 / 进程管理 / 托盘均为 Win32 语义）。

## License

[MIT](./LICENSE)
