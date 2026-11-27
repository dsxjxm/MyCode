# ============================================================
# TraeWork 每日积分签到（Windows PowerShell 版，兼容 PS 5.1）
#
# 流程：读取本地令牌 -> 查询签到状态 -> 未签到则领取 -> 写日志
# 用法：
#   powershell -ExecutionPolicy Bypass -File checkin.ps1
# 或（显式指定运行时）：
#   $env:TRAE_CHECKIN_NODE="C:/path/to/node.exe"
#   powershell -ExecutionPolicy Bypass -File checkin.ps1
# 定时（示例，每天 09:00）：
#   schtasks /Create /TN TraeWorkDailyCheckin /TR "powershell -ExecutionPolicy Bypass -File C:/path/checkin.ps1" /SC DAILY /ST 09:00 /F
#
# 凭据安全提示：
#   - 本地令牌（token）等同 TraeWork 账号密码，仅在本脚本内存中使用，
#     通过管道立即消费，不写入日志、不落地、不回显。
#   - 日志（logs/checkin.log）只记录签到结果（积分/成功失败），不含令牌。
#   - 切勿将日志、脚本输出粘贴分享或提交到任何仓库。
# ============================================================
$ErrorActionPreference = "Continue"

# 统一 UTF-8 解码，避免 PowerShell 5.1 中文乱码
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DecryptJs = Join-Path $ScriptDir "decrypt-token.js"
$SkillRoot = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $SkillRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "checkin.log"

function Write-Log([string]$msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Output $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# ---------- 可选：随机错峰（避免整点风暴） ----------
if ($env:TRAE_CHECKIN_JITTER) {
    try {
        $max = [int]$env:TRAE_CHECKIN_JITTER
        if ($max -gt 0) { Start-Sleep -Seconds (Get-Random -Maximum $max) }
    } catch {}
}

# ---------- 查找 Node.js ----------
function Find-Node {
    if ($env:TRAE_CHECKIN_NODE -and (Test-Path $env:TRAE_CHECKIN_NODE)) { return $env:TRAE_CHECKIN_NODE }
    $cands = @(
        (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return ""
}

$NodeBin = Find-Node
if (-not $NodeBin) {
    Write-Log "未找到 Node.js 运行时。请安装 Node.js 或设置 TRAE_CHECKIN_NODE 环境变量。"
    exit 1
}

# ---------- 1. 读取令牌和设备 ID ----------
$Token = ""; $DeviceId = ""; $UserId = ""; $Edition = ""
try {
    $outLines = & $NodeBin $DecryptJs 2>$null
    foreach ($l in $outLines) {
        if ($l -match "^DECRYPT_RESULT:") { $Token = ($l -replace "^DECRYPT_RESULT:", "").Trim() }
        elseif ($l -match "^DEVICE_ID:") { $DeviceId = ($l -replace "^DEVICE_ID:", "").Trim() }
        elseif ($l -match "^USER_ID:") { $UserId = ($l -replace "^USER_ID:", "").Trim() }
        elseif ($l -match "^EDITION:") { $Edition = ($l -replace "^EDITION:", "").Trim() }
    }
} catch {
    Write-Log "调用解密脚本出错：$($_.Exception.Message)"
    exit 1
}

if (-not $Token) {
    Write-Log "获取令牌失败，请确认已安装并登录 TraeWork / TraeCode 桌面端。"
    exit 1
}
if ($Token.StartsWith("ERR")) {
    Write-Log "获取令牌失败（$Token）。请确认已安装并登录 TraeWork / TraeCode 桌面端。"
    exit 1
}

$ApiBase = "https://api.trae.cn"

# ---------- API 调用函数 ----------
function Invoke-TraeApi([string]$Path) {
    $a = @(
        "-s", "-m", "20", "-w", "`n%{http_code}", "-X", "POST",
        "$ApiBase$Path",
        "-H", "Content-Type: application/json",
        "-H", "Accept: application/json",
        "-H", "Authorization: Cloud-IDE-JWT $Token",
        "-H", "Origin: https://www.trae.cn",
        "-H", "Referer: https://www.trae.cn/"
    )
    if ($DeviceId) { $a += "-H"; $a += "x-device-id: $DeviceId" }
    $a += "-d"; $a += "{}"
    $raw = & curl.exe @a 2>$null
    if (-not $raw) { return @("000", "") }
    $lines = @($raw)
    $code = [string]($lines | Select-Object -Last 1)
    $body = if ($lines.Count -gt 1) { ($lines | Select-Object -First ($lines.Count - 1)) -join "" } else { "" }
    return @($code, $body)
}

# ---------- 2. 查询签到状态 ----------
$Status = ""; $HttpCode = "000"
try { $r = Invoke-TraeApi "/trae/api/v2/ug/checkin_credits/status"; $HttpCode = $r[0]; $Status = $r[1] } catch { $HttpCode = "000"; $Status = "" }

if ($HttpCode -eq "000") { Write-Log "查询签到状态失败（网络异常）"; exit 1 }
if ($HttpCode -eq "401" -or $HttpCode -eq "403") { Write-Log "令牌已过期或无权限（HTTP $HttpCode），请打开 TraeWork 桌面端刷新登录态后重试"; exit 1 }
if ($HttpCode -ne "200") { Write-Log "查询签到状态失败（HTTP $HttpCode）"; exit 1 }
if (-not $Status) { Write-Log "查询签到状态失败（响应为空，HTTP $HttpCode）"; exit 1 }

# 解析状态
$CheckedIn = $false
$Credits = 0
$ExtraCredits = 0
$Enable = $false
try {
    $statusObj = $Status | ConvertFrom-Json
    $CheckedIn = [bool]$statusObj.checked_in
    $Credits = [int]$statusObj.credits
    if ($statusObj.extra_credits) { $ExtraCredits = [int]$statusObj.extra_credits }
    $Enable = [bool]$statusObj.enable
} catch {
    # JSON 解析失败时用正则兜底
    if ($Status -match '"checked_in"\s*:\s*true') { $CheckedIn = $true }
    if ($Status -match '"credits"\s*:\s*(\d+)') { $Credits = [int]$Matches[1] }
    if ($Status -match '"extra_credits"\s*:\s*(\d+)') { $ExtraCredits = [int]$Matches[1] }
}

if ($CheckedIn) {
    $total = $Credits + $ExtraCredits
    Write-Log "今日已签到，积分 $Credits（额外 $ExtraCredits，总计 $total）。版本：$Edition"
    exit 0
}

# ---------- 3. 执行签到 ----------
if (-not $Enable) {
    Write-Log "签到功能未启用，跳过。"
    exit 0
}

$Result = ""; $HttpCode2 = "000"
try { $r2 = Invoke-TraeApi "/trae/api/v2/ug/checkin_credits/claim"; $HttpCode2 = $r2[0]; $Result = $r2[1] } catch { $HttpCode2 = "000"; $Result = "" }

if ($HttpCode2 -eq "000") { Write-Log "签到请求失败（网络异常）"; exit 1 }
if ($HttpCode2 -eq "401" -or $HttpCode2 -eq "403") { Write-Log "令牌已过期或无权限（HTTP $HttpCode2），请打开 TraeWork 桌面端刷新登录态后重试"; exit 1 }
if (-not $Result) { Write-Log "签到请求失败（响应为空，HTTP $HttpCode2）"; exit 1 }

# 解析签到结果
$bodyCode = ""
$bodyMsg = ""
if ($Result -match '"code"\s*:\s*(\d+)') { $bodyCode = $Matches[1] }
if ($Result -match '"message"\s*:\s*"([^"]*)"') { $bodyMsg = $Matches[1] }

if ($bodyCode -eq "0") {
    # 签到成功，重新查询积分
    try {
        $r3 = Invoke-TraeApi "/trae/api/v2/ug/checkin_credits/status"
        if ($r3[0] -eq "200") {
            $s3 = $r3[1] | ConvertFrom-Json
            $c3 = [int]$s3.credits
            $ec3 = if ($s3.extra_credits) { [int]$s3.extra_credits } else { 0 }
            $total = $c3 + $ec3
            Write-Log "签到成功！领取积分 $c3（额外 $ec3，总计 $total）。版本：$Edition"
            exit 0
        }
    } catch {}
    Write-Log "签到成功！版本：$Edition（code=0, msg=$bodyMsg）"
    exit 0
} elseif ($bodyCode -eq "1001") {
    Write-Log "认证失败（code=1001），请打开 TraeWork 桌面端刷新登录态后重试"
    exit 1
} elseif ($bodyCode -eq "9004") {
    Write-Log "签到失败（code=9004，缺少设备 ID），请确认桌面端已正常登录"
    exit 1
} else {
    Write-Log "签到未成功：code=$bodyCode msg=$bodyMsg"
    exit 1
}
