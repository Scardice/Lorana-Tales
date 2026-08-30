<p align="center">
  <img src="web/public/icon.png" width="96" alt="Lorana Tales logo">
</p>

# Lorana Tales

[![Node](https://img.shields.io/badge/node-24.20%20LTS-green)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-latest-orange)](https://pnpm.io/)

前后端一体的 Lorana Tales TRPG 跑团 Log 着色器。

当前版本：`0.1.0-testify.1`。`Testify` 是项目的快速测试阶段，版本号遵循 SemVer：同一开发里程碑的快速迭代递增末尾序号（如 `0.1.0-testify.2`）；进入新的不兼容开发里程碑时递增次版本并从 `testify.1` 重新开始（如 `0.2.0-testify.1`）；功能冻结后进入 `1.0.0-rc.1`，通过发布验收后发布 `1.0.0`。正式版之后按 `主版本.次版本.修订号` 维护，Nightly Release 继续作为滚动构建，不占用稳定版本号。

- 前端：Vue 3 + Vite，源码在 `web/`
- 后端：Express + SQLite/WAL，TypeScript 源码按 Linux 服务程序结构放在 `src/`
- 编译产物：服务端 TS 编译到 `dist/`，前端构建到 `out/`
- 可执行入口源码：`src/bin/scardice-story-painter.ts`
- 运行入口产物：`dist/bin/scardice-story-painter.js`
- 内置 API 说明页位于 `/api-docs`
- 内置管理后台位于 `/admin`
- 高级沉浸编辑默认开启，支持头像、左右/旁白布局、批量插入与拖动、全屏编辑、动画播放和可继续编辑的 `.ssp` 工程包
- 可选账号系统支持 SMTP 邮件码、新设备/网段验证、风险验证码、云端工程和管理员账户管理
- [SSP v2 工程格式、安全边界与扩展方式](docs/ssp-v2.md)

## 接口

接口同时兼容 `/api/dice/...` 和 `/dice/api/...` 两种路径前缀。

- PUT `/api/dice/log` 或 `/dice/api/log`（multipart/form-data：`name`、`uniform_id=命名空间:标识符`、`file`；默认上传限制 5 MB）
- POST/PUT `/api/dice/w4123` 或 `/dice/api/w4123`（专门为 w4123/Dice 的第三方日志上传插件提供的上传接口）
- PUT `/api/dice/backup-upload` 或 `/dice/api/backup-upload`（备用上传接口，主存储失败时自动调用，支持级联）
- POST `/api/dice/load_data` 或 `/dice/api/load_data`，JSON：`{"key":"AbCd","password":"123456"}`。旧 GET 查询参数形式仅为兼容保留，公网部署请勿使用，避免密码进入浏览器历史和代理日志。
- 成功返回示例：`{"url":"http://localhost:3000/?key=AbCd#123456"}`

`uniform_id` 冒号后的标识符允许字母、数字、下划线、点和短横线。手动清理日志请使用登录后的管理后台。完整接口、健康检查、指标和管理 API 说明见 `/api-docs`。

上传内容如果命中安全拦截规则，服务端会拒绝写入并返回 422 纯文本警告；前端文件上传会跳转到安全警示页面。拦截事件会写入 `security.audit_log_path` 配置的 JSON Lines 审计日志。

## 快速开始

### 前置要求

- Node.js >= 24.20.0（生产环境仍推荐使用当前安全维护中的 Node 24 LTS）
- pnpm

### 安装与启动

```bash
# 1. 安装依赖
pnpm install

# 2. 编译服务端 TS 到 dist/，构建前端到 out/
pnpm build

# 3. 启动一体化服务
pnpm start
```

服务默认监听 `http://0.0.0.0:3000`。
API 说明页：`http://localhost:3000/api-docs`。
管理后台：`http://localhost:3000/admin`。

账号模式关闭且没有在 `config.toml` 配置管理密码时，服务启动会生成一个仅本次进程有效的 UUID，并打印在启动日志中。账号模式开启后不再使用这套旧管理密码。

### 开发模式

推荐使用一个命令同时启动后端和 Vite 开发服务器：

```bash
pnpm dev:all
```

也可以拆成两个终端运行：

```bash
# 终端 1：编译并启动后端 API；如果 out/ 已存在，也会托管静态产物
pnpm dev:server

# 终端 2：启动 Vite 前端开发服务器，/api 会代理到 http://localhost:3000
pnpm dev
```

生产部署仍使用 `pnpm build && pnpm start`。源码构建与 fork 会直接启动当前编译版本；带官方构建标记的 Linux Release 包则由同一个启动器进程托管工作进程与平滑更新代理。

### TypeScript 构建

服务端源码使用 TypeScript 编写，`pnpm build:server` 会把 `src/**/*.ts` 编译到 `dist/`。`pnpm start` 运行 `scripts/rolling-launcher.mjs`；不满足官方包自动更新条件时，它会直接运行编译后的 `dist/bin/scardice-story-painter.js`。

前端源码也使用 TypeScript/Vue SFC，`pnpm build:web` 会生成 `out/` 静态产物。

运行时 JS 来自 `dist/` 和 `out/assets/` 编译产物；辅助开发脚本放在 `scripts/`。

### Nightly Release

每次 `main` 分支有新提交时，GitHub Actions 会删除旧的 [Nightly Release](https://github.com/Scardice/Lorana-Tales/releases/tag/nightly) 与标签，再以当前提交重新创建。这样发布时间、源码归档与二进制包都严格对应同一基线，同时仍只保留一个滚动 Nightly。

Nightly 包面向 Linux x64，使用 Node.js `>=24.20.0`，已经包含服务端 `dist/`、前端 `out/`、生产依赖和 `better-sqlite3` 原生模块，不需要再编译源码。生产环境仍推荐使用当前安全维护中的 Node 24 LTS。下载 `.tar.gz` 或 `.zip` 后：

需要长期保留的测试版或正式版由仓库的 `Release` Action 手动创建：输入 `VERSION` 同格式的版本号，并选择 `test` 或 `stable`。测试版会标记为 prerelease，正式版会成为 latest；两者都使用独立版本标签，不会被 Nightly 覆盖。新版沉浸式染色器显示的完整构建版本为 `VERSION+Git短提交码`，例如 `0.1.0-testify.1+8280e02`。

```bash
# 解压后进入目录
cd lorana-tales-nightly

# 直接编辑已经准备好的运行配置；不要把真实密码或域名提交回源码仓库
$EDITOR config.toml

# 直接启动，不需要 pnpm install，也不需要重新构建
npm start

# 使用 PM2 或宝塔 PM2 项目时，直接托管包内的滚动启动器
# 配置固定为单实例 fork 模式，并自动使用当前解压目录与 config.toml
pm2 start ecosystem.config.cjs
pm2 save
```

包内同时保留 `config.toml.example` 和 `NIGHTLY-README.md`。如果要在其他操作系统上运行，建议使用源码仓库按当前平台重新执行 `pnpm install && pnpm build`，因为 `better-sqlite3` 的原生依赖与平台和 CPU 架构有关。

官方 Linux Release 包默认启用 `auto_update.channel = "nightly"`：启动器按完整提交号跟踪官方仓库滚动重建的 Nightly；`test` 跟随带 SemVer 版本号的测试版与正式版，`stable` 仅跟随正式版，`off` 关闭更新。更新时会同时核对 GitHub 资产摘要、`SHA256SUMS`、完整提交号和包内官方构建标记，归档还会经过路径、符号链接、文件数与解压体积检查；新版本在随机本机端口通过版本号与提交号健康检查后才切换内置代理，公网监听端口不会关闭，切换后 30 秒内异常退出会自动回退旧工作进程。源码构建、fork 或缺少官方标记的包不会自动更新。更新暂存目录、检查间隔和通道均在 `[auto_update]` 配置。

自动更新的信任根是官方 GitHub 仓库及其 Release 权限，因此维护者账号必须启用强验证，并建议为 Release Action 配置受保护环境与人工审批。普通前后端功能会无停机切换；若 Release 修改的是启动器本身的安全逻辑，仍应在维护窗口重启一次服务管理器，使新的启动器代码成为下一轮更新基线。

## 配置

### config.toml（主要配置方式）

配置文件 `config.toml` 位于项目根目录，支持以下配置项。该文件用于本地或生产环境的实际配置，默认已加入 `.gitignore`，不要提交包含真实域名、密码或 token 的副本。

首次配置可从示例文件复制：

```bash
cp config.toml.example config.toml
```

运行时也支持通过 `SCARDICE_CONFIG` 或 `CONFIG_FILE` 指定配置文件；未指定时会依次查找：

- `./config.toml`
- `/etc/scardice-story-painter/config.toml`
- `/etc/scardice-story-painter.toml`

示例配置见 `config.toml.example`。

```toml
[server]
host = "0.0.0.0"       # 监听地址
port = 3000             # 监听端口
trust_proxy = false     # 可信 CDN/反代链路才设为 true；直连部署保持 false
trusted_proxy_cidrs = ["127.0.0.1/32", "::1/128"] # 只有实际 TCP 对端命中时才信任转发头
allowed_hosts = ["localhost", "127.0.0.1", "::1"] # 加入用户实际访问的公开域名
hsts_max_age_seconds = 0 # HTTPS 全站确认可用后建议设为 31536000

[storage]
sqlite_path = "./data/scardice.db" # SQLite 数据库路径
max_total_mb = 4096 # 公共传统日志数据库总容量硬上限（MB）

[editor]
default_mode = "story" # 裸路径默认进入 story（新版）或 legacy（旧版）
enable_story_mode = true # 关闭后隐藏新版入口，/story 自动回落旧版

[branding]
site_title = "Lorana Tales" # 浏览器标题及上顶栏最右侧的网站名
show_site_title = false # 默认只显示组合品牌图；开启后在 Logo 旁额外显示网站名
logo_path = "./web/public/lorana-tales-brand.png" # PNG/SVG 本地路径；相对路径以项目根目录为准
favicon_path = "./web/public/favicon.ico" # ICO/PNG/SVG 本地路径
community_notice = "GitHub: https://github.com/Scardice/Lorana-Tales · QQ群：1080498667" # 经典提示与沉浸画布水印；留空隐藏

[resource_cache]
enabled = false # 上传时归档 CQ 图片、语音和附件；视频仅保留【视频】占位且不下载
path = "./data/cq-resources" # 本地媒体目录
retention_days = 60 # 资源归档保留天数，和日志保留天数独立
max_file_mb = 12 # 单个远程/内嵌资源的最大体积
max_resources_per_log = 40 # 单份日志最多下载的 CQ 资源数，以及最多预取的唯一 QQ 头像数
image_quality = 65 # PNG/JPEG/WebP 转 WebP 时的有损质量（1-100）
audio_bitrate_kbps = 128 # 语音转为 Ogg Opus 的目标码率
ffmpeg_path = "ffmpeg" # 系统 FFmpeg 路径；项目不捆绑 GPL 二进制
allowed_hosts = ["*.qq.com", "*.qlogo.cn", "*.qpic.cn", "*.gtimg.cn", "*.discordapp.com", "*.kookapp.cn", "*.kookcdn.com", "*.kaiheila.cn"] # 可信上游资源与平台头像域名
allow_public_hosts = false # 不建议开启；true 时允许任意公网域名
download_timeout_seconds = 15 # 单资源下载超时
max_concurrent_jobs = 2 # 图片/音频/无损压缩后台并发；上限 4
max_image_pixels = 40000000 # 图片像素总数硬限制
max_total_mb = 4096 # CQ 资源目录硬盘总配额

[accounts]
enabled = false # 开启账号注册、登录与云端工程
registration_enabled = true
initial_admin_username = "" # 第一次启动时创建的临时管理员用户名
initial_admin_password = "" # 至少 10 字符；首次登录后必须立刻更换
initial_admin_email = "" # 可留空，首次登录时仍必须填写正式邮箱
default_group = "default" # 新注册用户所属的存储组
admin_group = "admin" # 管理员专用组；角色和组同时满足才可进入管理面板
encryption_key = "" # 开启时必填，至少 32 个随机字符
captcha_provider = "image" # image / altcha / turnstile / hcaptcha

[accounts.smtp]
host = "smtp.example.com"
port = 587
secure = false
user = "no-reply@example.com"
password = ""
from = "Lorana Tales <no-reply@example.com>"
subject_template = "{{site_title}} {{purpose}}验证码"
html_template_path = "./email/verification.html" # 可选 .html/.htm 文件；支持 code、username、nickname、site_title、logo/logo_url、purpose、expires_minutes

[app]
frontend_url = ""        # 留空时使用代理解析后的外部域名；跨域/CDN 托管前端时固定填写公开 URL
log_retention_days = 60  # 日志保留天数
max_upload_mb = 5        # 上传大小限制
cleanup_on_start = false # 启动时清理过期日志
cleanup_after_upload = true # 上传后后台清理过期日志
backup_upload_api = ""   # 备用上传API（可选）

[admin]
password = ""            # 仅账号模式关闭时使用；留空则启动时生成进程内 UUID

[metrics]
enabled = false           # 默认关闭 /metrics
token = ""                # enabled=true 时必填，否则服务拒绝启动

[security]
injection_guard_enabled = true # 上传内容注入拦截；命中后拒绝写库并记录审计日志
audit_log_path = "./data/security-audit.log" # 安全审计日志路径，JSON Lines 格式
warning_quotes = [
  "Hey bro, what the fuck are you doing? Stop dreaming about being a hacker, you low-tech noob! 👎👎👎 Wake up, the floor is freezing!",
] # 安全拦截警告中的调笑语句数组，命中时随机抽取
admin_bruteforce_block_enabled = true # 管理后台疑似爆破时是否临时封禁来源 IP
admin_bruteforce_max_attempts = 8 # 统计窗口内失败次数阈值
admin_bruteforce_window_seconds = 60 # 失败次数统计窗口
admin_bruteforce_block_seconds = 60 # 触发后的封禁时长；期间访问会重定向到安全拦截页
```

### 环境变量（可选覆盖）

环境变量优先级高于 config.toml：

| 变量名                            | 说明                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `HOST`                            | 监听地址                                                   |
| `PORT`                            | 监听端口                                                   |
| `TRUST_PROXY`                     | 是否信任反向代理/CDN IP 头；设为 `true` 后读取真实客户端 IP |
| `ALLOWED_HOSTS`                   | 允许的 Host 头列表，逗号分隔                               |
| `SQLITE_PATH`                     | SQLite 数据库路径                                          |
| `DATABASE_PATH`                   | SQLite 数据库路径兼容变量；和 `SQLITE_PATH` 同时设置时优先 |
| `EDITOR_DEFAULT_MODE`             | 裸路径默认编辑器：`story` 或 `legacy`                      |
| `EDITOR_ENABLE_STORY_MODE`        | 是否开放并显示新版沉浸式染色器                             |
| `SITE_TITLE`                      | 浏览器标题及上顶栏网站名                                   |
| `SITE_SHOW_TITLE`                 | 是否在顶栏 Logo 旁显示网站名                               |
| `SITE_LOGO_PATH`                  | 顶栏 PNG/SVG Logo 的本地路径                               |
| `SITE_FAVICON_PATH`               | ICO/PNG/SVG favicon 的本地路径                             |
| `CQ_RESOURCE_CACHE_ENABLED`        | 是否归档 CQ 资源                                           |
| `CQ_RESOURCE_CACHE_PATH`           | CQ 资源存储目录                                            |
| `CQ_RESOURCE_CACHE_RETENTION_DAYS` | CQ 资源保留天数                                            |
| `CQ_RESOURCE_CACHE_MAX_FILE_MB`    | 单资源体积限制                                             |
| `CQ_RESOURCE_CACHE_MAX_RESOURCES_PER_LOG` | 单日志资源数量上限                                  |
| `CQ_RESOURCE_CACHE_IMAGE_QUALITY`  | WebP 有损压缩质量（1-100）                                |
| `CQ_RESOURCE_CACHE_AUDIO_BITRATE_KBPS` | Ogg Opus 语音目标码率（kbps）                         |
| `CQ_RESOURCE_CACHE_ALLOWED_HOSTS`  | 可信上游域名，逗号分隔                                     |
| `CQ_RESOURCE_CACHE_ALLOW_PUBLIC_HOSTS` | 是否允许任意公网域名                                  |
| `CQ_RESOURCE_CACHE_DOWNLOAD_TIMEOUT_SECONDS` | 单资源下载超时秒数                              |
| `ACCOUNTS_ENABLED`                | 是否开启账号与云端工程                                   |
| `ACCOUNTS_REGISTRATION_ENABLED`   | 是否开放自行注册                                         |
| `ACCOUNTS_INITIAL_ADMIN_USERNAME` | 首次启动临时管理员用户名                                 |
| `ACCOUNTS_INITIAL_ADMIN_PASSWORD` | 首次启动临时管理员密码；首次登录后强制更换               |
| `ACCOUNTS_INITIAL_ADMIN_EMAIL`    | 临时管理员初始邮箱，可留空                               |
| `ACCOUNTS_ENCRYPTION_KEY`         | 工程源密钥加密主密钥，至少 32 字符                       |
| `ACCOUNTS_PASSWORD_ATTEMPTS_PER_MINUTE` | 单一来源网段每分钟密码登录尝试上限                  |
| `ACCOUNT_KDF_CONCURRENCY`         | 密码 scrypt 并发上限，默认 2、最高 4                    |
| `ACCOUNT_KDF_QUEUE_LIMIT`         | 等待密码校验的队列上限，默认 64、最高 256               |
| `ACCOUNTS_CAPTCHA_PROVIDER`       | `image`、`altcha`、`turnstile` 或 `hcaptcha`             |
| `SMTP_HOST` / `SMTP_PORT`         | SMTP 主机与端口                                           |
| `SMTP_SECURE`                     | 是否使用隐式 TLS                                          |
| `SMTP_USER` / `SMTP_PASSWORD`     | SMTP 登录凭据                                             |
| `SMTP_FROM`                       | 验证码发件人                                              |
| `ALTCHA_HMAC_KEY`                 | 自托管 ALTCHA HMAC 密钥                                   |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 配置                   |
| `HCAPTCHA_SITE_KEY` / `HCAPTCHA_SECRET_KEY` | hCaptcha 配置                                  |
| `FRONTEND_URL`                    | 生成查看链接时使用的前端地址；留空则使用当前请求域名       |
| `LOG_RETENTION_DAYS`              | 日志保留天数                                               |
| `MAX_UPLOAD_MB`                   | 上传大小限制                                               |
| `CLEANUP_ON_START`                | 启动时清理过期日志                                         |
| `CLEANUP_AFTER_UPLOAD`            | 上传后后台清理过期日志                                     |
| `BACKUP_UPLOAD_API`               | 备用上传API                                                |
| `ADMIN_PASSWORD`                  | 仅账号模式关闭时使用的旧管理后台密码                       |
| `METRICS_ENABLED`                 | 是否开启 `/metrics`                                        |
| `METRICS_TOKEN`                   | `/metrics` Bearer token                                    |
| `TRUSTED_PROXY_CIDRS`             | 允许提供转发头的直接代理 CIDR，逗号分隔                    |
| `HSTS_MAX_AGE_SECONDS`            | HTTPS HSTS 秒数；本地 HTTP 保持 0                           |
| `CQ_RESOURCE_CACHE_MAX_CONCURRENT_JOBS` | 资源处理并发上限                                      |
| `CQ_RESOURCE_CACHE_MAX_IMAGE_PIXELS` | 图片最大像素总数                                         |
| `CQ_RESOURCE_CACHE_MAX_TOTAL_MB`  | CQ 资源目录硬盘总配额                                      |
| `INJECTION_GUARD_ENABLED`         | 是否开启上传内容注入拦截                                   |
| `SECURITY_AUDIT_LOG_PATH`         | 安全审计日志路径                                           |
| `SECURITY_WARNING_QUOTES`         | 安全拦截调笑语句，逗号分隔                                 |
| `ADMIN_BRUTEFORCE_BLOCK_ENABLED`  | 是否启用管理后台疑似爆破封禁                               |
| `ADMIN_BRUTEFORCE_MAX_ATTEMPTS`   | 爆破判定失败次数阈值                                       |
| `ADMIN_BRUTEFORCE_WINDOW_SECONDS` | 爆破统计窗口秒数                                           |
| `ADMIN_BRUTEFORCE_BLOCK_SECONDS`  | 爆破触发后的封禁秒数                                       |
| `SCARDICE_CONFIG`                 | 配置文件路径                                               |
| `CONFIG_FILE`                     | 配置文件路径，低于 `SCARDICE_CONFIG` 优先级                |

示例：

```bash
PORT=8080 SQLITE_PATH=/mnt/data/scardice.db pnpm start
```

默认预制 `default`、`advanced`、`admin` 三个存储组；额度按工程压缩后的实际数据库占用计算，并由服务端强制执行。`default_group` 决定新用户所属组，`admin_group` 决定管理员专用组。只有同时具有 `admin` 角色并属于 `admin_group` 的账户才能进入管理面板；服务启动时会把已有管理员迁移到管理员组，并把误入管理员组的普通用户迁回默认组。

管理员可在账户编辑弹窗中切换普通用户的存储组，也可为单个用户覆盖存储额度和不活跃清理期限：留空表示继承组策略，期限填 `0` 表示永久保留。管理员角色会自动锁定到 `admin` 组，但同样允许单独覆盖额度与期限。默认策略如下：

```toml
[accounts.storage_groups.default]
quota_mb = 256
max_projects = 100
retention_days = 180 # 工程连续 180 天未被打开或保存时自动删除；0 为永久保留

[accounts.storage_groups.advanced]
quota_mb = 2048
max_projects = 1000
retention_days = 365

[accounts.storage_groups.admin]
quota_mb = 8192
max_projects = 5000
retention_days = 0 # 管理员默认永久保留
```

### 反向代理与 CDN 客户端 IP

当服务位于可信的 Nginx、Caddy、Cloudflare、Fastly 或其他 CDN 后方时，将 `trust_proxy = true`，并把直接连接本服务的代理地址或网段写入 `trusted_proxy_cidrs`（或 `TRUSTED_PROXY_CIDRS`）。服务端只有在 TCP 对端命中该列表时，才按以下优先级读取真实客户端 IP：`CF-Connecting-IP`、`True-Client-IP`、`Fastly-Client-IP`、`X-Real-IP`、`X-Client-IP`、`X-Forwarded-For`，最后兼容 RFC 7239 的 `Forwarded: for=`。

这些请求头需要同时满足 `trust_proxy=true` 与直接对端命中 `trusted_proxy_cidrs` 才会被信任；直连部署保持 `false`。不要使用 `0.0.0.0/0` 或 `::/0`，反向代理也应覆盖或清理公网请求携带的同名头。`allowed_hosts` 仍必须加入用户实际访问的域名；它与代理信任是两项独立检查。

```toml
[server]
trust_proxy = true
trusted_proxy_cidrs = ["127.0.0.1/32", "::1/128"]
```

如果使用 Cloudflare，通常保留 `CF-Connecting-IP`，并让 Cloudflare 转发到源站；如果使用普通反代，至少配置 `X-Forwarded-For` 或 `X-Real-IP`。真实 IP 会用于上传记录、限流、管理后台爆破防护和安全拦截关联。

### CQ 资源本地归档

开启 `[resource_cache].enabled` 后，服务会在上传时解压日志，提取 `CQ:image`、`face`、`record`、`voice`、`audio` 和 `file` 中的 URL 或 base64 资源，下载后将日志引用改为本站 `/cq-resources/...`。`CQ:video` 永远不会下载或写入硬盘，而会改成 `【视频】` 占位，避免视频耗尽服务端空间。默认只允许腾讯 QQ/QLogo/QPic/GTImg 域名；如日志确实使用其他图床，应将对应域名加入 `allowed_hosts`，而不是直接开启 `allow_public_hosts`。

PNG、JPEG 和 WebP 会以 `image_quality` 重编码为 WebP；只有更小才替换原文件。GIF 会保持原格式和动画。语音会通过系统 FFmpeg 转为 128kbps（或 `audio_bitrate_kbps`）的 Ogg Opus；如果输出反而更大则保留较小的原文件。项目只调用运维环境提供的 FFmpeg，不捆绑其二进制，从而不把 GPL 分发义务混入 MIT 发布包。所有保存后的资源还会使用最高质量 Brotli 无损压缩；支持 Brotli 的浏览器直接得到压缩流，其他客户端由服务端即时解压。

资源在有损处理后以 SHA-256 命名，相同内容只保存一份；编辑器上传重复文件时会提示并复用现有资源。处理任务受 `max_concurrent_jobs` 限制，图片同时受 `max_image_pixels` 限制，整个目录受 `max_total_mb` 硬配额限制。`retention_days` 从资源归档成功时计算，与日志的 `log_retention_days` 独立。未归档的 CQ 图片和语音在新版界面只显示 `【图片】` / `【语音】`，不会暴露 CQ 原文；用户也可以主动填写并验证一个 HTTP(S) 直链，这类资源直接由浏览器读取、不写入服务端。远程资源解析会锁定已校验的公网 IP，并在每次重定向后重新校验，避免 DNS 重绑定访问内网。被拒绝、超限、超时或下载失败的 CQ 资源不会导致日志上传失败。

### QQ、Discord 与 KOOK 头像

新版会根据日志中的数字身份长度推断平台，并把获取到的头像转存到本地资源缓存。QQ 无需鉴权；Discord 与 KOOK 必须分别开启 `[avatar_providers].discord_enabled` / `kook_enabled` 并在服务端配置 Bot Token。Token 不会进入前端响应。平台返回用户名时会与日志昵称做弱匹配；匹配成功优先使用对应平台，候选都不匹配时优先 QQ。明显属于 Discord 的长 ID 若鉴权失败则保持无头像，不会硬套 QQ 头像。角色上传自定义头像后，可在角色编辑中点击“使用/刷新平台头像”恢复并重新拉取。

生产环境优先用 `DISCORD_BOT_TOKEN`、`KOOK_BOT_TOKEN` 环境变量注入密钥，不要把真实 Token 写入 Git。Discord Token 应按密码保护；这里只调用只读用户资料接口，不要求额外消息权限。

### 沉浸编辑、SSP 与账号

新版沉浸式染色器位于 `/story`，旧版位于 `/legacy`；裸路径 `/` 服从 `[editor].default_mode`。关闭 `[editor].enable_story_mode` 后会隐藏新版入口并让 `/story` 回落旧版。新版是独立的固定视口 Web App，旧版配置区不会混入其中。

新版会把旧格式日志无损映射为故事工程，旁白角色固定存在且不可删除。修改会保存在当前浏览器的 IndexedDB，刷新或再次打开相同日志时会询问是否恢复。`Ctrl+S` 下载 `.ssp`：它是包含 `metadata.lorana`、`story.lorana`、`manifest.lorana` 与 `assets/` 的高压缩 ZIP 工程包，不保存 JSON 故事文档。标题和作者署名单独写入最外层 `metadata.lorana`；`story.lorana` 使用用户可直接编辑的 Lorana Tales Story Language，例如 `<time:2000ms>` 控制消息停留时间、`<wt:100ms>文字<wt/>` 控制局部逐词停顿。内嵌 HTML 下载前会询问本次署名，播放器会在开始前展示标题和作者。编辑器内置语法文档和应用前校验，SSP 会校验压缩包路径、文件数和解压体积，旧版染色器日志也可直接导入新版。

预览支持手动/自动演出、逐词动画、录制编排、组内头像跟随滚动、图片查看、语音波形播放、按消息边界分页的长图导出，以及尽可能把资源内嵌为 Data URL 的独立 HTML。传统 Word 导出仍采用原先的角色名与正文排版，不导出聊天气泡。

开启 `[accounts].enabled` 后，注册时会分别填写只允许字母、数字、`_`、`-` 的登录用户名和可自由显示的昵称；登录既支持“用户名或邮箱 + 密码”，也支持邮箱验证码免密登录。用户可在个人中心修改昵称、头像和邮箱，并把自有编辑副本保存为云端工程；登录状态下从网页上传的旧日志会自动归入账号，骰子机器人上传的匿名日志仍可由用户另存为自己的工程。工程分享链接本身就是无需登录的只读播放链接：有限期工程可让链接动态跟随工程到期，也可在分享弹窗选择不晚于工程到期时间的固定 1–365 天；永久保留工程必须为分享链接选择固定期限，不提供永久分享。过期链接返回 410，重新生成/更新有效期不会暴露源工程写权限。个人中心会同时显示空间、工程数量和未活动保留期限；打开或保存工程都会续期。管理员可以让用户继承账号组期限、永久保留，或单独分配天数。新设备、浏览器指纹或 IP 网段变化（IPv4 `/24`、IPv6 `/64`）以及异常行为会要求邮件验证码或 CAPTCHA。风控只要求验证或冷却，不会自动永久封号。管理员既能访问原有的全部服务端日志，也能在 `/admin` 查看所有用户云端工程副本，并可新增、删除、编辑、升降管理员、改邮箱和密码、分配存储组与保留期限、停用或带理由封禁用户；系统阻止移除最后一个可用管理员。账号模式使用配置中的初始管理员账号完成首次引导，首次登录必须更换正式用户名、邮箱和密码；完成后初始凭据和旧 `[admin].password` 都不能再登录。

账号开启时 `accounts.encryption_key` 必须至少 32 字符。注册与新设备登录还需要可用 SMTP；建议生产环境使用 HTTPS，并保护配置文件中的 SMTP 密码、CAPTCHA 密钥与加密主密钥。

### 公网部署安全核对表

- 只让 HTTPS 反代/CDN 暴露公网端口，Node 源站绑定内网地址；确认 `allowed_hosts` 只包含真实域名。
- 只有启用反代时才打开 `trust_proxy`，并把 `trusted_proxy_cidrs` 收窄到实际直连源站的代理网段；不要使用全网 CIDR。
- 通过环境变量注入 SMTP、Discord/KOOK、CAPTCHA、初始管理员和 `accounts.encryption_key` 等密钥，不提交真实 `config.toml`。
- 开启 `/metrics` 时必须设置高强度 `metrics.token`；不需要指标时保持关闭。
- 按硬盘容量设置日志、账号工程和 CQ 资源配额，定期备份 SQLite 数据库及资源目录，并实际演练恢复。
- 首次登录后立即更换引导管理员凭据；管理员必须同时具有 `admin` 角色并处于 `admin` 组。
- 分享地址是公开只读播放器链接，不支持永久有效；链接只能跟随工程到期或设置为更短的固定期限，删除/到期的工程无法再通过分享访问。
- 上线前运行 `pnpm audit`、`pnpm test:security`、`pnpm lint`、`pnpm test:story-format`、`pnpm test:account-groups` 与 `pnpm build`。

### 备用API（可选）

配置备用API实现日志上传高可用，当主存储失败时自动转发到备用服务器。

**级联支持**：同一套代码可部署在不同服务器上，形成链式备用关系：
主服务器 → 备用服务器1 → 备用服务器2 → ...

### 日志保留策略

为了防止存储空间溢出，系统支持自动清理过期日志。

- 默认保留 60 天（可在 `config.toml` 中修改）
- 每次上传日志时自动检查并清理过期日志
- 也可在登录后的管理后台手动触发清理

## 数据存储

日志默认存储于 SQLite 数据库 `./data/scardice.db`（可通过 `storage.sqlite_path` 配置）。
服务启动时会自动创建 schema，并启用 WAL 模式。

当前表结构把列表元数据和正文分开：

- `log_records`：日志名称、上传时间、IP、消息数、大小等元数据
- `log_payloads`：原始存储 JSON 正文
- `schema_migrations`：数据库迁移版本记录

管理端列表只查询 `log_records`，不会扫描正文；正文只在读取详情、公开读取和 raw export 时访问。

## 项目结构

```text
src/bin/                     # TypeScript 可执行入口源码
src/api/                     # HTTP API 业务处理
src/config/                  # 配置加载
src/server/                  # Express 服务启动
src/storage/                 # SQLite 存储和日志解析
scripts/                     # 本地开发辅助脚本
web/                         # Vue/Vite 前端源码和静态管理页
dist/                        # 服务端 TypeScript 编译产物，生成目录
out/                         # 前端构建产物，由服务进程托管，生成目录
data/                        # 默认 SQLite 数据目录，运行时生成
config.toml.example          # 可提交的配置示例
config.toml                  # 本地/生产配置，默认忽略不提交
```

## 项目参考

- [海豹骰日志前端](https://github.com/sealdice/story-painter)
- [海豹骰日志后端 - CF版](https://github.com/sealdice/story-painter-cfbackend)
- [海豹骰日志后端 - EO版](https://github.com/DiceZone/story-painter-eobackend)

## 许可证

本项目采用 [MIT License](LICENSE)。带图 Word 导出的第三方组件声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
