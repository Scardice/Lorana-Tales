<p align="center">
  <img src="web/public/icon.png" width="96" alt="Scardice Story Painter logo">
</p>

# Scardice Story Painter

[![Node](https://img.shields.io/badge/node-%3E=20.19-green)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-latest-orange)](https://pnpm.io/)

前后端一体的余烬 TRPG 跑团 Log 着色器部署版本。

- 前端：Vue 3 + Vite，源码在 `web/`
- 后端：Express + SQLite/WAL，TypeScript 源码按 Linux 服务程序结构放在 `src/`
- 编译产物：服务端 TS 编译到 `dist/`，前端构建到 `out/`
- 可执行入口源码：`src/bin/scardice-story-painter.ts`
- 运行入口产物：`dist/bin/scardice-story-painter.js`
- 内置 API 说明页位于 `/api-docs`
- 内置管理后台位于 `/admin`

## 接口

接口同时兼容 `/api/dice/...` 和 `/dice/api/...` 两种路径前缀。

- PUT `/api/dice/log` 或 `/dice/api/log`（multipart/form-data：`name`、`uniform_id=命名空间:标识符`、`file`；默认上传限制 5 MB）
- POST/PUT `/api/dice/w4123` 或 `/dice/api/w4123`（专门为 w4123/Dice 的第三方日志上传插件提供的上传接口）
- PUT `/api/dice/backup-upload` 或 `/dice/api/backup-upload`（备用上传接口，主存储失败时自动调用，支持级联）
- GET `/api/dice/load_data?key=AbCd&password=123456` 或 `/dice/api/load_data?key=AbCd&password=123456`
- 成功返回示例：`{"url":"http://localhost:3000/?key=AbCd#123456"}`

`uniform_id` 冒号后的标识符允许字母、数字、下划线、点和短横线。手动清理日志请使用登录后的管理后台。完整接口、健康检查、指标和管理 API 说明见 `/api-docs`。

上传内容如果命中安全拦截规则，服务端会拒绝写入并返回 422 纯文本警告；前端文件上传会跳转到安全警示页面。拦截事件会写入 `security.audit_log_path` 配置的 JSON Lines 审计日志。

## 快速开始

### 前置要求

- Node.js >= 20.19
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

如果没有在 `config.toml` 配置管理密码，服务启动时会生成一个仅本次进程有效的 UUID，并打印在启动日志中。

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

生产部署仍使用 `pnpm build && pnpm start`，只需要启动一个 Node 进程。

### TypeScript 构建

服务端源码使用 TypeScript 编写，`pnpm build:server` 会把 `src/**/*.ts` 编译到 `dist/`。`pnpm start` 只运行编译后的 `dist/bin/scardice-story-painter.js`。

前端源码也使用 TypeScript/Vue SFC，`pnpm build:web` 会生成 `out/` 静态产物。

运行时 JS 来自 `dist/` 和 `out/assets/` 编译产物；辅助开发脚本放在 `scripts/`。

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
trust_proxy = false     # 是否信任反向代理 IP 头
allowed_hosts = ["localhost", "127.0.0.1", "::1"] # 允许的 Host 头；生产环境加入你的域名

[storage]
sqlite_path = "./data/scardice.db" # SQLite 数据库路径

[app]
frontend_url = ""        # 留空时自动使用当前请求域名，适合前后端一体部署
log_retention_days = 60  # 日志保留天数
max_upload_mb = 5        # 上传大小限制
cleanup_on_start = false # 启动时清理过期日志
cleanup_after_upload = true # 上传后后台清理过期日志
backup_upload_api = ""   # 备用上传API（可选）

[admin]
password = ""            # 管理后台密码；留空则启动时生成一次性 UUID

[metrics]
enabled = false           # 默认关闭 /metrics
token = ""                # 可选：开启后要求 Authorization: Bearer <token>

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
| `TRUST_PROXY`                     | 是否信任反向代理 IP 头                                     |
| `ALLOWED_HOSTS`                   | 允许的 Host 头列表，逗号分隔                               |
| `SQLITE_PATH`                     | SQLite 数据库路径                                          |
| `DATABASE_PATH`                   | SQLite 数据库路径兼容变量；和 `SQLITE_PATH` 同时设置时优先 |
| `FRONTEND_URL`                    | 生成查看链接时使用的前端地址；留空则使用当前请求域名       |
| `LOG_RETENTION_DAYS`              | 日志保留天数                                               |
| `MAX_UPLOAD_MB`                   | 上传大小限制                                               |
| `CLEANUP_ON_START`                | 启动时清理过期日志                                         |
| `CLEANUP_AFTER_UPLOAD`            | 上传后后台清理过期日志                                     |
| `BACKUP_UPLOAD_API`               | 备用上传API                                                |
| `ADMIN_PASSWORD`                  | 管理后台密码                                               |
| `METRICS_ENABLED`                 | 是否开启 `/metrics`                                        |
| `METRICS_TOKEN`                   | `/metrics` Bearer token                                    |
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
