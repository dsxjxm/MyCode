# Changelog

## 1.0.0 (2026-10-01)

### 新功能

- 初始版本发布
- 支持 TraeWork / TraeCode 桌面端本地登录态 AES-128-CBC 解密
- 自动探测多个安装目录（TRAE SOLO CN、Trae CN、TRAE SOLO、Trae）
- 调用官方签到 API 完成每日积分领取
- 幂等签到：今日已签到自动跳过
- 设备 ID 自动获取（icube-dc / telemetry / machineid 多级回退）
- 支持 Windows PowerShell 和 macOS/Linux bash 两种脚本
- 支持环境变量配置（Node 路径、storage 路径、应用名、错峰等待）
- 支持定时任务配置（schtasks / crontab / Agent 自动化）
- 安全设计：令牌仅在内存中使用，不写入日志、不落地
