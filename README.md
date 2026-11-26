# 局域网仿真实训教学平台

浏览器/服务器（B/S）架构的局域网仿真实训教学平台，面向职业院校课堂实训。

技术栈：**Node.js + Express + SQLite（sql.js WASM，零原生依赖）+ 原生前端**，无构建步骤、离线可用，`npm start` 一键启动。

已上线四个实训模块：

| 模块 | 内容 |
| --- | --- |
| WWW / IIS 站点 | 文件空间管理、分屏代码编辑器、实时预览、站点设置（默认文档、MIME、访问日志） |
| FTP / Telnet 终端 | 命令行模拟、目录浏览、上传下载、FTP 账号与空间管理 |
| DNS / DHCP 网络模拟 | SVG 拓扑画布、PC 拖放、DHCP 地址池分配、DNS 记录解析、ipconfig/ping/nslookup/tracert/arp/netsh 命令模拟 |
| 邮件服务器 SMTP / POP3 | 邮箱注册（别名、图形验证码、模拟短信）、密码/短信登录、收发邮件、附件、富文本、通讯簿、黑名单、定时发送、SMTP/POP3 协议日志 |

---

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows / macOS / Linux |
| Node.js | **>= 20.0.0**（推荐 20 LTS 或 22 LTS） |
| 浏览器 | Chrome / Edge / Firefox 最新版 |

> 查看版本：`node -v`。安装包下载：<https://nodejs.org/>

---

## 二、本地部署流程

### 1. 解压

把压缩包解压到任意目录，例如 `D:\lan-sim\`。

### 2. 安装依赖

在该目录打开终端（Windows：文件夹地址栏输入 `cmd` 回车）：

```bash
npm install
```

> 首次安装需联网。若网络较慢，可先执行
> `npm config set registry https://registry.npmmirror.com` 再安装。

### 3. 启动

```bash
npm start
```

看到如下输出即启动成功：

```
局域网仿真实训教学平台 已启动
本机访问：http://localhost:3000
局域网访问：http://192.168.x.x:3000
教师初始账号：admin / admin123
```

浏览器打开 <http://localhost:3000>，自动进入登录页。

### 4. 停止

在运行终端按 `Ctrl + C`。

---

## 三、默认账号

| 角色 | 账号 | 密码 | 说明 |
| --- | --- | --- | --- |
| 教师 | `admin` | `admin123` | 班级/学生管理、通知、四模块管理 |
| 学生 | `20250101` | `123456` | 张三（演示） |
| 学生 | `20250102` | `123456` | 李四（演示） |
| 学生 | `20250103` | `123456` | 王五（演示） |
| 教师邮箱 | `teacher@example.local` | `123456` | 可在邮件模块「邮箱别名注册」中修改 |

首次启动自动创建演示班级、3 名学生与上述邮箱账号，无需额外初始化。

> 学生首次进入邮件模块需完成「注册邮箱」（绑定学生账号、自选别名、模拟短信验证码），之后即可收发邮件。
> 模拟短信不会真的发送，验证码会显示在页面右下角的模拟手机短信弹窗中。

---

## 四、目录说明

```
.
├── server/              # 后端
│   ├── index.js         # 入口（端口、路由挂载、启动任务）
│   ├── db.js            # 建表、迁移与演示数据 seed
│   ├── paths.js         # 数据目录定位
│   ├── services/        # 业务模拟（WWW/FTP/DNS-DHCP/邮件等）
│   └── routes/          # HTTP 接口
├── public/              # 前端页面与静态资源（无构建）
├── scripts/             # 辅助脚本
├── test/                # 单元测试（npm test）
├── data/                # 运行时数据（自动生成，勿删）
└── package.json
```

### 数据保存位置

- 默认：项目下的 `data/` 目录（`platform.db`、学生文件空间、邮件附件等）
- 如该目录不可写，自动回退到系统临时目录 `lan-sim-data`
- 也可自定义：

```bash
# Windows
set DATA_DIR=D:\lan-sim-data && npm start

# macOS / Linux
DATA_DIR=/opt/lan-sim-data npm start
```

> 删除 `data/` 相当于重置平台（演示数据会在下次启动时重新生成）。

---

## 五、局域网内学生访问

启动日志中的「局域网访问」地址即学生访问地址（如 `http://192.168.1.100:3000`）。

- 学生电脑需与教师机在同一局域网
- 打不开时检查教师机防火墙是否放行 3000 端口
- 修改端口：

```bash
# Windows
set PORT=8080 && npm start

# macOS / Linux
PORT=8080 npm start
```

---

## 六、其它命令

```bash
npm test       # 运行单元测试
npm run dev    # 开发模式（后端改动自动重启）
```

---

## 七、常见问题

**1. 端口被占用**
换端口启动：`PORT=8080 npm start`（Windows 用 `set PORT=8080 && npm start`）。

**2. 启动报 Cannot find module**
未安装依赖或安装不完整，重新执行 `npm install`。

**3. 数据想恢复初始状态**
停止服务，删除 `data/` 目录后重新 `npm start`。

**4. 学生邮件验证码在哪里看**
点击「获取验证码」后，页面右下角会弹出模拟手机短信，显示 6 位验证码，可点「一键填入」。

**5. 教师如何关闭学生编辑网络配置**
教师控制台 →「模块管理」→ 网络模拟卡片中的开关「允许学生编辑 DHCP / DNS / PC 配置」。
