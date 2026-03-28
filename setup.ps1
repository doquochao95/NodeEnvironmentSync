# setup.ps1 - BOOTSTRAP INSTALLER FOR NES (Node-Environment Sync)
$ErrorActionPreference = "Stop"

$currentDir = $PSScriptRoot
$versionsDir = Join-Path $currentDir "versions"
$bootstrapVersion = "22.2.0"
$bootstrapFolderName = "v$bootstrapVersion"
$bootstrapPath = Join-Path $versionsDir $bootstrapFolderName

Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "   NES (Node-Environment Sync) AUTOMATIC BOOTSTRAP             " -ForegroundColor Magenta
Write-Host "==========================================================" -ForegroundColor Magenta

# 1. Create necessary directories
Write-Host "[1/6] Checking version storage directory..." -ForegroundColor Cyan
if (-not (Test-Path $versionsDir)) {
    New-Item -ItemType Directory -Path $versionsDir | Out-Null
    Write-Host "  Created: $versionsDir" -ForegroundColor Green
} else {
    Write-Host "  Already exists: $versionsDir" -ForegroundColor Gray
}

# 2. Initialize local NES configuration
$nesConfigPath = Join-Path $currentDir "nes_config.json"
Write-Host "[2/6] Checking NES configuration..." -ForegroundColor Cyan
if (-not (Test-Path $nesConfigPath)) {
    @{ managed_packages = @() } | ConvertTo-Json | Set-Content -Path $nesConfigPath -Force
    Write-Host "  Created: nes_config.json" -ForegroundColor Green
} else {
    Write-Host "  Already exists: nes_config.json" -ForegroundColor Gray
}

# 3. Check and download bootstrap Node.js
Write-Host "[3/6] Checking Node.js installation..." -ForegroundColor Cyan
$existingNode = $null
if (Test-Path $versionsDir) {
    $existingNode = Get-ChildItem -Path $versionsDir -Directory | Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } | Select-Object -First 1
}

if ($existingNode) {
    $bootstrapPath = $existingNode.FullName
    Write-Host "  Found: $($existingNode.Name) - Using as bootstrap" -ForegroundColor Green
} elseif (-not (Test-Path $bootstrapPath)) {
    Write-Host "  Downloading Node.js v$bootstrapVersion..." -ForegroundColor Yellow
    $url = "https://nodejs.org/dist/v$bootstrapVersion/node-v$bootstrapVersion-win-x64.zip"
    $zipFile = Join-Path $currentDir "node_temp.zip"
    
    Invoke-WebRequest -Uri $url -OutFile $zipFile
    
    Write-Host "  Extracting..." -ForegroundColor Yellow
    Expand-Archive -Path $zipFile -DestinationPath $currentDir -Force
    
    # Move extracted folder to versions directory
    $extractedFolder = Join-Path $currentDir "node-v$bootstrapVersion-win-x64"
    Move-Item -Path $extractedFolder -Destination $bootstrapPath
    
    # Cleanup temp zip
    Remove-Item $zipFile
    Write-Host "  Installed: $bootstrapPath" -ForegroundColor Green
} else {
    Write-Host "  Bootstrap already exists" -ForegroundColor Gray
}

# 4. Create 'current' junction link
Write-Host "[4/6] Creating junction link..." -ForegroundColor Cyan
$currentPath = Join-Path $currentDir "current"
if (Test-Path $currentPath) {
    cmd /c "rmdir ""$currentPath"""
    Write-Host "  Removed old junction" -ForegroundColor Gray
}
New-Item -ItemType Junction -Path $currentPath -Target $bootstrapPath | Out-Null
Write-Host "  Created: current -> $($bootstrapPath)" -ForegroundColor Green

# 5. Install NES dependencies
Write-Host "[5/6] Installing NES dependencies..." -ForegroundColor Cyan
$npmCmd = Join-Path $bootstrapPath "npm.cmd"
if (Test-Path $npmCmd) {
    Push-Location $currentDir
    & $npmCmd install --silent --no-fund --no-audit
    Pop-Location
    Write-Host "  Dependencies installed successfully" -ForegroundColor Green
} else {
    Write-Host "  Warning: npm.cmd not found" -ForegroundColor Yellow
}

# 6. Configure Windows Environment PATH
Write-Host "[6/6] Configuring Windows System PATH..." -ForegroundColor Cyan
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$isCurrentInPath = $userPath -match [regex]::Escape($currentPath)
$isAppInPath = $userPath -match [regex]::Escape($currentDir)

$newPath = $userPath
if (-not $isCurrentInPath) { $newPath = "$currentPath;" + $newPath }
if (-not $isAppInPath) { $newPath = "$currentDir;" + $newPath }

if ($newPath -ne $userPath) {
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  PATH updated successfully" -ForegroundColor Green
} else {
    Write-Host "  PATH already configured" -ForegroundColor Gray
}

# Migration: Migrate data from old NVM (if exists)
Write-Host "[Optional] Checking for legacy NVM..." -ForegroundColor Cyan
$nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "User")
if ($null -eq $nvmHome) { $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Machine") }

if ($null -ne $nvmHome -and (Test-Path $nvmHome)) {
    Write-Host "  Found: $nvmHome" -ForegroundColor Yellow
    Write-Host "  Migrating existing Node.js versions..." -ForegroundColor Yellow
    
    $nvmDirs = Get-ChildItem -Path $nvmHome -Directory
    foreach ($dir in $nvmDirs) {
        $destNodeDir = Join-Path $versionsDir $dir.Name
        if (-not (Test-Path $destNodeDir)) {
            Write-Host "    Migrating: $($dir.Name)..." -ForegroundColor Yellow
            Copy-Item -Path $dir.FullName -Destination $destNodeDir -Recurse -Force
            Write-Host "    Done" -ForegroundColor Green
        }
    }
} else {
    Write-Host "  No legacy NVM found" -ForegroundColor Gray
}

# Finalization: Create nes.cmd
Write-Host "[Final] Creating nes command..." -ForegroundColor Cyan
$nesCmdFile = Join-Path $currentDir "nes.cmd"
$cmdContent = "@echo off`r`nnode ""%~dp0index.js"" %*"
Set-Content -Path $nesCmdFile -Value $cmdContent -Force
Write-Host "  Created: nes.cmd" -ForegroundColor Green

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   NES INSTALLATION COMPLETE!                             " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Please RESTART your Terminal / VS Code / CMD to start using NES."
Write-Host "Usage command: nes"
pause
