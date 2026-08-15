# restart-dsh-web.ps1
# Detached restart for the dsh web service (--port 3080).
#
# WHY DETACHED: when this script runs as a child of the dsh web process tree
# (e.g. invoked by the agent inside a dsh session), a plain `taskkill /T`
# would kill THIS script together with the old tree, so the "start new web"
# half would never run. Instead, the real kill+start work is handed to a
# one-shot Windows Scheduled Task, which runs under the Task Scheduler
# service and is NOT part of the dsh process tree. This script only
# registers and fires that task, then exits immediately.
#
# NOTE: restarting the web service drops every connected browser session;
# users must refresh the page afterwards. Conversation history is durable.

$ErrorActionPreference = 'Continue'

$logDir = 'C:\Users\mengf\.dsh\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'dsh-web-restart.log'
function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Tee-Object -FilePath $log -Append
}

Write-Log '=== restart script started (detached mode) ==='

# ---------------------------------------------------------------------------
# 1. Write the restart body script (the part that must survive the tree kill).
# ---------------------------------------------------------------------------
$bodyPath = Join-Path $logDir 'restart-body.ps1'

$body = @'
$ErrorActionPreference = 'Continue'
$logDir = 'C:\Users\mengf\.dsh\logs'
$log = Join-Path $logDir 'dsh-web-restart.log'
function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Tee-Object -FilePath $log -Append
}

# Give the caller a moment to finish before the tree kill.
Start-Sleep -Seconds 8

# 1. Kill the old web service (whole tree, incl. MCP children).
$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $oldPid = $listener.OwningProcess
    Write-Log "killing old web pid $oldPid (tree)"
    taskkill /PID $oldPid /T /F 2>&1 | Out-String | Tee-Object -FilePath $log -Append
    Start-Sleep -Seconds 3
} else {
    Write-Log 'port 3080 not listening, skip kill'
}

# 2. Clean stale sh wrappers.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh web --port 3080' -and $_.Name -eq 'sh.exe' } |
    ForEach-Object {
        Write-Log "killing stale sh wrapper pid $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

# 3. Start the new web service (detached from this task process).
$env:DSH_HOME = 'C:\Users\mengf\.dsh'
$node = 'C:\Program Files\nodejs\node.exe'
$bin = 'C:\Users\mengf\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$stdout = Join-Path $logDir 'dsh-web.stdout.log'
$stderr = Join-Path $logDir 'dsh-web.stderr.log'
$proc = Start-Process -FilePath $node -ArgumentList @("`"$bin`"", 'web', '--port', '3080') `
    -WorkingDirectory 'C:\Users\mengf' -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Write-Log "started new web pid $($proc.Id)"

# 4. Health check: poll port 3080 for up to 60s.
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $l = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($l) {
        $ok = $true
        Write-Log "health OK: port 3080 listening (pid $($l.OwningProcess)) after $([int](($i + 1) * 2))s"
        break
    }
}
if (-not $ok) { Write-Log 'health FAILED: port 3080 not listening after 60s' }

# 4.5 Notify the originating session that the restart finished, so the agent
#     wakes up and reports "restarted" to the user by itself.
#     The message text is base64-encoded UTF-8: this whole file is read by
#     Windows PowerShell 5.1 as ANSI, so raw CJK literals MUST NOT appear.
$flagPath = Join-Path $logDir 'restart-pending.flag'
try {
    $flagJson = [System.IO.File]::ReadAllText($flagPath) | ConvertFrom-Json
    $sid = $flagJson.sessionId
    if ($sid -and $ok) {
        $notifyText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5bey6YeN5ZCv'))
        $notifyText = $notifyText.Replace('$procId', [string]$proc.Id)
        $rpcMsg = @{
            type = 'client-request'
            rpcId = "restart-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
            method = 'session.prompt'
            payload = @{
                sessionId = $sid
                mode = 'queue'
                content = @(@{ type = 'text'; text = $notifyText })
            }
        } | ConvertTo-Json -Depth 6 -Compress
        $sent = $false
        for ($attempt = 1; $attempt -le 8 -and -not $sent; $attempt++) {
            try {
                # PS 5.1 encodes a string body as Latin-1; send UTF-8 bytes instead.
                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($rpcMsg)
                $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/api/session.prompt' -Method Post -Body $bodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 15 -UseBasicParsing
                if ($resp.StatusCode -eq 200) {
                    $sent = $true
                    Write-Log "session notified (http 200, attempt $attempt)"
                }
            } catch {
                Write-Log "notify attempt $attempt failed: $($_.Exception.Message)"
                Start-Sleep -Seconds 3
            }
        }
        if (-not $sent) { Write-Log 'session notify gave up after 8 attempts' }
    }
} catch {
    Write-Log "session notify failed: $($_.Exception.Message)"
}

# 5. Clean up the one-shot scheduled task, the pending flag, and this body.
schtasks /Delete /TN dsh-web-restart /F 2>&1 | Out-Null
Remove-Item (Join-Path $logDir 'restart-pending.flag') -Force -ErrorAction SilentlyContinue
Remove-Item $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
Write-Log '=== detached restart finished ==='
'@

[System.IO.File]::WriteAllText($bodyPath, $body, (New-Object System.Text.UTF8Encoding $false))

# ---------------------------------------------------------------------------
# 2. Write the pending flag (front-end shows the overlay immediately). The
#    flag also carries the originating session id so the detached task can
#    notify that session once the new service is healthy.
# ---------------------------------------------------------------------------
$flagPath = Join-Path $logDir 'restart-pending.flag'
try {
    $sid = $env:DSH_SESSION_ID
    if (-not $sid) { $sid = '' }
    $flagJson = @{ sessionId = $sid; at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($flagPath, $flagJson, (New-Object System.Text.UTF8Encoding $false))
    Write-Log "pending flag written (sessionId=$sid)"
} catch {
    Write-Log "pending flag write failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 3. Register and fire the one-shot scheduled task (independent process tree).
# ---------------------------------------------------------------------------
$taskName = 'dsh-web-restart'
$taskCmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bodyPath`""
schtasks /Create /TN $taskName /TR $taskCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
$fire = schtasks /Run /TN $taskName 2>&1 | Out-String
Write-Log "scheduled task fired: $($fire.Trim())"
if ($fire -notmatch 'SUCCESS') {
    Write-Log 'task fire FAILED: clearing pending flag'
    Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
} else {
    # Verify the task actually started (a Ready task means it never ran).
    Start-Sleep -Seconds 5
    $state = (schtasks /Query /TN $taskName /FO CSV 2>&1 | Out-String).Trim()
    if ($state -notmatch 'Running') {
        Write-Log "task did not reach Running state after fire, clearing flag (state: $state)"
        Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
    } else {
        Write-Log 'task confirmed Running'
    }
}

Write-Log '=== restart script finished (detached task will do the work) ==='
