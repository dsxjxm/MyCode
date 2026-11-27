# 依赖清单（Dependencies）

本 skill 运行链路：**读取本地令牌（AES-128-CBC 解密）→ 调用官方 API → 写日志**。所需依赖如下。

## 核心依赖（必须有）

| 组件 | 作用 | 获取方式 | 说明 |
|---|---|---|---|
| TraeWork / TraeCode 桌面端（已登录） | 提供本地登录态（storage.json） | 官网下载：https://www.trae.cn/ | 必须已登录过至少一次，否则没有可读的令牌 |
| Node.js（推荐 18+） | AES-128-CBC 解密令牌、解析 JSON | nodejs.org 下载 LTS；或系统包管理器 | 必需；可用 `TRAE_CHECKIN_NODE=<path>` 指定 |
| curl（sh 版） / curl.exe（ps1 版） | 调用签到 API | macOS/Linux 自带；Windows 10 1803+ 自带 curl.exe | — |

> 解密算法使用纯 Node.js 内置 `crypto` 模块，**无需 Electron、无需 npm 包、无需编译**。开箱即用。

## 网络要求

- 需可访问 `https://api.trae.cn`（签到 API）
- 仅访问官方域名，不上传任何第三方

## 平台差异速查

自动探测以下安装目录，按顺序查找第一个有有效登录态的目录。SOLO（Work 版）优先于 IDE 版，CN 版优先于国际版。

| 平台 | Shell | storage.json 路径（按优先级） | machineid 路径 |
|---|---|---|---|
| **macOS** | `checkin.sh`（bash） | `~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json`<br>`~/Library/Application Support/Trae CN/User/globalStorage/storage.json`<br>`~/Library/Application Support/TRAE SOLO/User/globalStorage/storage.json`<br>`~/Library/Application Support/Trae/User/globalStorage/storage.json` | `~/Library/Application Support/<AppName>/machineid` |
| **Windows** | `checkin.ps1`（PowerShell）或 Git Bash 跑 `checkin.sh` | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`<br>`%APPDATA%\Trae CN\User\globalStorage\storage.json`<br>`%APPDATA%\TRAE SOLO\User\globalStorage\storage.json`<br>`%APPDATA%\Trae\User\globalStorage\storage.json` | `%APPDATA%\<AppName>\machineid` |
| **Linux** | `checkin.sh`（bash） | `~/.config/TRAE SOLO CN/User/globalStorage/storage.json`<br>`~/.config/Trae CN/User/globalStorage/storage.json`<br>`~/.config/TRAE SOLO/User/globalStorage/storage.json`<br>`~/.config/Trae/User/globalStorage/storage.json` | `~/.config/<AppName>/machineid` |

Windows PowerShell 执行策略用 `-ExecutionPolicy Bypass`；需 `curl.exe`（Win10 1803+ 自带）。

## 设备 ID 获取优先级

签到 API 需要 `x-device-id` 请求头（缺少会返回 code 9004）。设备 ID 按以下优先级获取：

1. **`iCubeAuthInfo://icube-dc:<id>`** — 设备中心 ID（从 storage.json 键名提取）
2. **`telemetry.devDeviceId`** — 遥测设备 ID（storage.json 中的字段）
3. **SHA-256(telemetry.machineId)** — 取前 32 字节十六进制
4. **SHA-256(machineid 文件)** — 取前 32 字节十六进制

## 解密算法说明

密文格式（base64 编码后存储于 storage.json）：

```
+---------+------------------+---------------------------+
| 6 bytes |    32 bytes      |     N bytes (AES-CBC)     |
|  Header  |     Random      |        Ciphertext         |
+---------+------------------+---------------------------+
```

密钥派生：

```
first = SHA-512(Random)
salt = SALT_A XOR SALT_B      (64 bytes)
derived = SHA-512(first || salt)   (64 bytes)
AES-Key = derived[0:16]       (128-bit key)
AES-IV  = derived[16:32]      (128-bit IV)
```

明文结构（解密后）：

```
+-------------------------+----------------------+
|      64 bytes           |    remaining bytes   |
|  SHA-512(Plaintext)     |     Plaintext        |
+-------------------------+----------------------+
```

完整性校验：解密后前 64 字节应为后续明文的 SHA-512 哈希值，不匹配则视为解密失败。

## 安装后的目录结构

```
traework-checkin/
├── SKILL.md
├── CHANGELOG.md
├── references/
│   └── dependencies.md
├── scripts/
│   ├── decrypt-token.js      # 跨平台：AES-128-CBC 解密（纯 Node.js）
│   ├── checkin.sh            # macOS / Linux / Git Bash
│   └── checkin.ps1           # Windows PowerShell
└── logs/                     # 签到日志（自动创建）
```
