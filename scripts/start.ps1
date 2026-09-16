<#
.SYNOPSIS
  Starts voice-code-bridge end to end: ensures cloudflared, opens a quick
  tunnel to the bridge's HTTP port, prints the connector URL to paste into
  claude.ai, checks the bridge is registered as a Claude Code MCP server,
  then launches Claude Code with the channel enabled.

  Run from the repo root: powershell -File scripts\start.ps1
#>

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Home_ = if ($env:VCB_HOME) { $env:VCB_HOME } else { Join-Path $env:USERPROFILE '.voice-code-bridge' }
$Port = if ($env:VCB_PORT) { $env:VCB_PORT } else { '8790' }
$BinDir = Join-Path $Home_ 'bin'
$CloudflaredExe = Join-Path $BinDir 'cloudflared-windows-amd64.exe'
$TunnelLog = Join-Path $Home_ 'cloudflared.log'
$TunnelOut = Join-Path $Home_ 'cloudflared.out.log'
$ProjectDir = (Get-Location).Path

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# --- Ensure cloudflared -------------------------------------------------
if (-not (Test-Path $CloudflaredExe)) {
    Write-Host "cloudflared not found, downloading latest release..."
    $releaseUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Invoke-WebRequest -Uri $releaseUrl -OutFile $CloudflaredExe
    Write-Host "Downloaded cloudflared to $CloudflaredExe"
}

# --- Get the bridge's secret (starts the bridge process just long enough
#     to write config.json if it doesn't exist yet, via print-url) --------
$printUrlOutput = & node (Join-Path $RepoRoot 'bin\voice-code-bridge.mjs') print-url
$localUrl = ($printUrlOutput | Select-String -Pattern '^http://').ToString().Trim()
Write-Host "Bridge secret path: $Home_\config.json"

# --- Prefer a Tailscale Funnel (stable URL) if one serves our port -------
# Set up once with: tailscale funnel --bg <port>. Tailscale keeps it across reboots.
$tunnelUrl = $null
$tunnelProc = $null
try {
    $funnel = (& tailscale funnel status 2>$null) -join "`n"
    $m = [regex]::Match($funnel, 'https://[a-zA-Z0-9.-]+\.ts\.net')
    if ($m.Success -and $funnel -match 'Funnel on' -and $funnel -match "127\.0\.0\.1:$Port") {
        $tunnelUrl = $m.Value
        Write-Host "Using Tailscale Funnel: $tunnelUrl"
    }
} catch { }

# --- Otherwise start a quick tunnel as a background process --------------
if (-not $tunnelUrl) {
    if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }
    $tunnelProc = Start-Process -FilePath $CloudflaredExe `
        -ArgumentList @('tunnel', '--url', "http://localhost:$Port") `
        -RedirectStandardOutput $TunnelOut `
        -RedirectStandardError $TunnelLog `
        -PassThru -NoNewWindow
    Write-Host "Waiting for cloudflared to report a tunnel URL..."
}
$deadline = (Get-Date).AddSeconds(30)
while (-not $tunnelUrl -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $TunnelLog) {
        $match = Select-String -Path $TunnelLog -Pattern 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($match) { $tunnelUrl = $match.Matches[0].Value }
    }
}

if (-not $tunnelUrl) {
    Write-Warning "Could not read the tunnel URL from $TunnelLog within 30s. Check that file manually."
} else {
    # Extract the secret from the local URL (everything after /mcp/)
    $secret = $localUrl -replace '^.*\/mcp\/', ''
    $connectorUrl = "$tunnelUrl/mcp/$secret"
    Write-Host ""
    Write-Host "Connector URL (paste into your claude.ai custom connector):"
    Write-Host "  $connectorUrl"
    Write-Host ""
    if ($tunnelProc) {
        Write-Host "NOTE: this quick-tunnel URL changes every restart. Re-edit the connector"
        Write-Host "each time, or set up a stable one once: tailscale funnel --bg $Port"
        Write-Host ""
    }
}

# --- Check whether the bridge is registered as an MCP server ------------
$registered = $false
try {
    & claude mcp get voice-bridge *> $null
    if ($LASTEXITCODE -eq 0) { $registered = $true }
} catch {
    $registered = $false
}

if (-not $registered) {
    $binPath = Join-Path $RepoRoot 'bin\voice-code-bridge.mjs'
    Write-Host "voice-bridge is not registered with Claude Code yet. Register it with:"
    Write-Host "  claude mcp add --scope user voice-bridge -- node `"$binPath`""
    Write-Host "Then re-run this script."
    Write-Host ""
}

# --- Launch Claude Code with the channel enabled -------------------------
# Runs in the directory you started the script from (your project).
# VCB_ACTIVE tells the bridge in THIS session to open the voice endpoint.
Write-Host "Launching Claude Code in $ProjectDir"
$env:VCB_ACTIVE = '1'
try {
    & claude --dangerously-load-development-channels server:voice-bridge --remote-control
} finally {
    Remove-Item Env:VCB_ACTIVE -ErrorAction SilentlyContinue
    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Write-Host "Stopping cloudflared tunnel..."
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
}
