---
name: traework-checkin
description: TraeWork 每日积分自动签到。自动解密本地登录令牌（AES-128-CBC），调用官方签到 API 完成每日积分领取（免费用户 150 积分/天，会员用户 200 积分/天），并支持配置定时任务。触发词：TraeWork 签到、每日积分、签到领积分、check-in、credits。
version: "1.0.0"
license: MIT
display_name: TraeWork 每日签到领积分
display_name_en: TraeWork Daily Check-in
description_zh: TraeWork 每日积分自动签到。自动解密本地登录令牌（AES-128-CBC + SHA-512 密钥派生），调用官方签到 API 完成每日积分领取，支持多安装目录自动探测、幂等签到、定时任务配置。
description_en: Automatically check in to TraeWork daily to claim credits (150/day for free users, 200/day for members) by decrypting the local login token (AES-128-CBC + SHA-512 key derivation) and calling the official check-in API; supports multi-install auto-detection, idempotent check-in, and scheduled task setup.
---

# TraeWork 每日签到领积分

自动领取 TraeWork 每日积分（免费用户 150 积分/天，会员用户 200 积分/天）。
全流程在本机完成：读取本地登录态 → AES-128-CBC 解密 → 调用官方签到接口。无后端服务。

## 原理

1. TraeWork 桌面端登录后，会在本地 `storage.json` 中保存登录态，字段名为 `iCubeAuthInfo://icube.cloudide`，使用 **AES-128-CBC** 加密存储。
2. 解密算法：从密文中提取 32 字节随机数，通过 SHA-512 双层哈希 + 固定盐派生 AES 密钥和 IV，解密后通过 SHA-512 完整性校验验证明文。
3. 自动探测多个安装目录（Trae CN、TRAE SOLO CN、Trae、TRAE SOLO），优先使用设备中心 ID（`iCubeAuthInfo://icube-dc:`）作为 `x-device-id`。
4. 调用官方签到 API：
   - 查状态：`POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status`
   - 执行签到：`POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim`
   - 认证：`Authorization: Cloud-IDE-JWT <token>`
   - 设备标识：`x-device-id: <deviceId>`
5. 脚本幂等：先查状态（今日已签到即跳过）；重复调用不会重复发放积分（接口幂等）。

## 文件结构

```
traework-checkin/
├── SKILL.md
├── CHANGELOG.md
├── references/
│   └── dependencies.md         # 依赖清单与平台差异
├── scripts/
│   ├── decrypt-token.js        # 解密令牌（跨平台，纯 Node.js）
│   ├── checkin.sh              # macOS / Linux / Git Bash
│   └── checkin.ps1             # Windows PowerShell
└── logs/                       # 签到日志（自动创建）
```

## 依赖

### 系统依赖

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| TraeWork / TraeCode 桌面端（已登录） | 提供本地登录态（storage.json） | 官网下载，必须登录过至少一次 |
| Node.js（推荐 18+） | 解密 AES-128-CBC 令牌、解析 JSON | nodejs.org 下载，或系统包管理器 |
| curl（macOS/Linux 自带）/ curl.exe | 调用签到 API | Windows 10 1803+ 自带 |

> 仅需 Node.js，**无需 Electron**。解密算法为纯 Node.js 内置 crypto 模块实现。

## 快速开始

### Windows（PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\checkin.ps1
```

### macOS / Linux

```bash
bash scripts/checkin.sh
```

前提：本机已安装并**登录** TraeWork 或 TraeCode 桌面端；系统已安装 Node.js。

## 设置定时任务

脚本幂等，重复运行无副作用。推荐设置多个时间点补签，确保电脑在任一时间点开机就能签上。

### Windows（任务计划程序）

```powershell
# 每天 09:00 签到
schtasks /Create /TN TraeWorkDailyCheckin /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\scripts\checkin.ps1" /SC DAILY /ST 09:00 /F

# 每天 12:00 补签（schtasks 单任务只支持一个 /ST，多时间点需建多个任务）
schtasks /Create /TN TraeWorkDailyCheckin2 /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\scripts\checkin.ps1" /SC DAILY /ST 12:00 /F
```

推荐时间点：09:00 / 12:00 / 15:00 / 18:00 / 21:00

### macOS / Linux（crontab）

```bash
crontab -e
0 9,12,15,18,21 * * * /path/to/scripts/checkin.sh >> /path/to/logs/checkin.log 2>&1
```

### 在 TraeWork 内（Agent 自动化）

使用自动化任务工具（`automation_update`，recurring 类型）：

```json
{
  "name": "TraeWork 每日积分签到",
  "scheduleType": "recurring",
  "rrule": "FREQ=DAILY;BYHOUR=9,12,15,18,21;BYMINUTE=0;BYSECOND=0",
  "cwds": ["<用户工作目录>"],
  "status": "ACTIVE",
  "prompt": "运行 PowerShell 脚本 scripts/checkin.ps1（macOS/Linux 用 checkin.sh）。该脚本幂等：今日已签到会直接跳过。读取输出并汇报：签到成功领取多少积分 / 今日已签到 / 令牌失效需打开 TraeWork 刷新登录。"
}
```

## 平台说明

自动探测以下安装目录，按顺序查找第一个有有效登录态的目录：

| 平台 | 应用名（按优先级） | storage.json 路径 |
|------|-------------------|-------------------|
| **Windows** | Trae CN → TRAE SOLO CN → Trae → TRAE SOLO | `%APPDATA%\<AppName>\User\globalStorage\storage.json` |
| **macOS** | Trae CN → TRAE SOLO CN → Trae → TRAE SOLO | `~/Library/Application Support/<AppName>/User/globalStorage/storage.json` |
| **Linux** | Trae CN → TRAE SOLO CN → Trae → TRAE SOLO | `~/.config/<AppName>/User/globalStorage/storage.json` |

设备 ID 获取优先级：
1. `iCubeAuthInfo://icube-dc:<id>`（设备中心 ID）
2. `telemetry.devDeviceId`
3. SHA-256(`telemetry.machineId`)，前 32 字节十六进制
4. SHA-256(`machineid` 文件内容)，前 32 字节十六进制

## 环境变量

| 变量 | 作用 |
|------|------|
| `TRAE_CHECKIN_NODE=<path>` | 指定 Node 二进制路径 |
| `TRAE_CHECKIN_STORAGE=<path>` | 手动指定 storage.json 路径（跳过自动探测） |
| `TRAE_CHECKIN_APP=<name>` | 指定应用名（如 "Trae CN"），跳过自动探测 |
| `TRAE_CHECKIN_JITTER=<秒>` | 启动前随机等待 0~N 秒，避免整点风暴 |

## 安全说明

> ⚠️ **凭据即账号密码**：本技能解密的 token 等同你的 TraeWork 账号密码，具有高敏感性。请务必遵守以下红线：

- 令牌仅在内存中使用，通过管道立即被签到请求消费，**不写入任何日志文件、不落盘、不回显到终端、不提交到仓库**。
- `logs/` 仅记录签到结果（积分 / 成功失败），**绝不含令牌原文**。切勿将日志或脚本输出粘贴分享。
- 网络访问仅发往 TRAE 官方接口 `api.trae.cn/trae/api/v2/ug/checkin_credits/*`，不上传任何第三方。
- 解密成功时脚本会向 stderr 打印一行安全提示（不影响 stdout 的 token 管道），便于确认凭据正在被使用。
- 请勿用于他人账户、批量注册刷分或任何违反 TraeWork 用户协议的用途；使用者自行承担使用风险。

### 解密原理说明

本技能使用 AES-128-CBC 解密 Trae 本地登录态，解密所需的密钥派生盐值来自 Trae 客户端内置常量（与官方客户端同源）。解密过程完全在本机执行，不联网、不上传。

- 密文格式：6 字节头部 + 32 字节随机数 + AES-CBC 密文
- 密钥派生：SHA-512(SHA-512(随机数) XOR-Salt) → 前 16 字节为 AES 密钥，16-31 字节为 IV
- 完整性校验：解密后前 64 字节为明文的 SHA-512 哈希，用于验证数据完整性

## 排错

- **「未找到本地登录态」**：请确认已安装并登录 TraeWork 或 TraeCode 桌面端。检查 Node.js 是否安装（`node -v`），或用 `TRAE_CHECKIN_NODE` 指定路径。
- **「解密失败 / 完整性校验失败」**：storage.json 可能损坏或加密格式已变更。请打开桌面端刷新登录态后重试。
- **「认证失败（code 1001）」**：令牌已过期，请打开 TraeWork 桌面端刷新登录态；脚本每次运行会重新读取最新 token。
- **「签到失败（code 9004）」**：缺少 `x-device-id` 头，请确认 storage.json 中有设备 ID 相关字段。
- **「401 / 403」**：令牌无效或权限不足，打开桌面端重新登录。
- **Windows 提示不是内部或外部命令**：用 `powershell -ExecutionPolicy Bypass -File …` 运行；确认 `curl.exe` 存在。

## 积分规则

| 用户类型 | 每日签到积分 | 有效期 |
|---------|------------|--------|
| 免费用户 | 150 积分/天 | 31 个自然日 |
| 会员用户 | 200 积分/天 | 31 个自然日 |

会员套餐还包含每月固定积分（Lite 2000 / Pro 4000 / Pro+ 12000 / Ultra 40000），签到积分在此基础上额外发放。
