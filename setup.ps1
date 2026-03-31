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

# --- FUNCTION: Find all NVM installations ---
function Find-NvmInstallations {
    $foundPaths = @()
    
    # 1. Common paths (current user)
    $commonPaths = @(
        "$env:APPDATA\nvm",
        "$env:LOCALAPPDATA\nvm",
        "C:\Program Files\nvm",
        "C:\Program Files (x86)\nvm"
    )
    foreach ($p in $commonPaths) {
        if ($p -and (Test-Path $p)) { $foundPaths += $p }
    }
    
    # 2. Environment variables
    $envVars = @("NVM_HOME", "NVM_SYMLINK")
    foreach ($var in $envVars) {
        $val = [Environment]::GetEnvironmentVariable($var, "User")
        if (-not $val) { $val = [Environment]::GetEnvironmentVariable($var, "Machine") }
        if ($val -and (Test-Path $val) -and $foundPaths -notcontains $val) { 
            $foundPaths += $val 
        }
    }
    
    # 3. Search in all users' AppData directories
    $usersDir = "C:\Users"
    if (Test-Path $usersDir) {
        Get-ChildItem -Path $usersDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $userAppData = Join-Path $_.FullName "AppData\Roaming\nvm"
            if (Test-Path $userAppData) {
                $foundPaths += $userAppData
            }
        }
    }
    
    # 4. Search via registry
    try {
        $regPaths = @(
            "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
        )
        foreach ($rp in $regPaths) {
            if (Test-Path $rp) {
                Get-ChildItem -Path $rp -ErrorAction SilentlyContinue | ForEach-Object {
                    $displayName = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).DisplayName
                    $installLocation = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).InstallLocation
                    if ($displayName -match "NVM" -and $installLocation -and (Test-Path $installLocation)) {
                        if ($foundPaths -notcontains $installLocation) {
                            $foundPaths += $installLocation
                        }
                    }
                }
            }
        }
    } catch {}
    
    # 5. Search via nvm.exe
    $nvmCmd = Get-Command nvm.exe -ErrorAction SilentlyContinue
    if ($nvmCmd) {
        $nvmExePath = Split-Path $nvmCmd.Source -Parent
        if (Test-Path $nvmExePath) {
            $foundPaths += $nvmExePath
        }
    }
    
    return $foundPaths | Select-Object -Unique
}

# --- MIGRATION SECTION ---
Write-Host "[Optional] Checking for legacy NVM data migration..." -ForegroundColor Cyan
$allNvmPaths = Find-NvmInstallations

if ($allNvmPaths.Count -gt 0) {
    Write-Host "  Found $($allNvmPaths.Count) NVM installation(s)" -ForegroundColor Yellow
    
    if (-not (Test-Path $versionsDir)) {
        New-Item -ItemType Directory -Path $versionsDir | Out-Null
    }
    
    foreach ($nvmHome in $allNvmPaths) {
        Write-Host "  Processing: $nvmHome" -ForegroundColor Yellow
        
        if (Test-Path $nvmHome) {
            $nvmDirs = Get-ChildItem -Path $nvmHome -Directory -ErrorAction SilentlyContinue
            foreach ($dir in $nvmDirs) {
                if ($dir.Name -match '^v\d+') {
                    $destNodeDir = Join-Path $versionsDir $dir.Name
                    if (-not (Test-Path $destNodeDir)) {
                        Write-Host "    Migrating: $($dir.Name)..." -ForegroundColor Yellow
                        Copy-Item -Path $dir.FullName -Destination $destNodeDir -Recurse -Force
                        Write-Host "    Done" -ForegroundColor Green
                    }
                }
            }
        }
    }
    Write-Host "  Migration completed" -ForegroundColor Green
} else {
    Write-Host "  No legacy NVM found" -ForegroundColor Gray
}

# --- NVM CLEANUP SECTION ---
Write-Host "[NVM Cleanup] Removing all NVM installations..." -ForegroundColor Cyan

# 1. Remove all NVM directories found
foreach ($nvmHome in $allNvmPaths) {
    if ($nvmHome -and (Test-Path $nvmHome)) {
        Write-Host "  Removing: $nvmHome" -ForegroundColor Yellow
        Remove-Item -Path $nvmHome -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 2. Remove NVM environment variables (all users via registry)
Write-Host "  Cleaning environment variables..." -ForegroundColor Yellow

# Current user
$nvmVars = @("NVM_HOME", "NVM_SYMLINK")
foreach ($var in $nvmVars) {
    $val = [Environment]::GetEnvironmentVariable($var, "User")
    if ($val) {
        [Environment]::SetEnvironmentVariable($var, $null, "User")
    }
}

# Machine level (requires admin, but try anyway)
try {
    foreach ($var in $nvmVars) {
        $val = [Environment]::GetEnvironmentVariable($var, "Machine")
        if ($val) {
            [Environment]::SetEnvironmentVariable($var, $null, "Machine")
        }
    }
} catch {}

# 3. Clean NVM entries from PATH (current user)
Write-Host "  Cleaning PATH entries..." -ForegroundColor Yellow
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$originalPath = $userPath
$newPath = ($userPath -split ';' | Where-Object { 
    $_ -notmatch '\\nvm' -and $_ -notmatch '\\nodejs'
}) -join ';'

if ($newPath -ne $originalPath) {
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}

# 4. Remove Node from Program Files
Write-Host "  Removing Node.js from Program Files..." -ForegroundColor Yellow
$nodePaths = @("C:\Program Files\nodejs", "C:\Program Files (x86)\nodejs")
foreach ($np in $nodePaths) {
    if (Test-Path $np) {
        Remove-Item -Path $np -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 5. Remove registry keys
Write-Host "  Cleaning registry..." -ForegroundColor Yellow
$regPaths = @(
    "HKCU:\Software\nodejs",
    "HKLM:\Software\nodejs",
    "HKCU:\Software\NVM",
    "HKLM:\Software\NVM"
)
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Remove-Item -Path $rp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Remove NVM from Add/Programs
try {
    $uninstallPaths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($up in $uninstallPaths) {
        if (Test-Path $up) {
            Get-ChildItem -Path $up -ErrorAction SilentlyContinue | ForEach-Object {
                $displayName = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).DisplayName
                if ($displayName -match "NVM") {
                    Remove-Item -Path $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
} catch {}

Write-Host "  NVM cleanup completed!" -ForegroundColor Green

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "   NES SETUP                                           " -ForegroundColor Magenta
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