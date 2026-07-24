param(
    [string]$AppOutDir = "release/win-unpacked",
    [string]$ProjectDir = "."
)

$ErrorActionPreference = "Stop"

function Resolve-RcEditPath {
    $cacheDir = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
    if (-not (Test-Path $cacheDir)) {
        throw "winCodeSign cache not found: $cacheDir"
    }

    $candidates = Get-ChildItem $cacheDir -Recurse -Filter "rcedit-x64.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending

    if (-not $candidates -or $candidates.Count -eq 0) {
        throw "rcedit-x64.exe not found under $cacheDir"
    }

    return $candidates[0].FullName
}

function Resolve-MainExe([string]$ResolvedAppOutDir) {
    $exeCandidates = Get-ChildItem $ResolvedAppOutDir -Filter "*.exe" |
        Where-Object { $_.Name -notin @("elevate.exe") -and $_.Name -notlike "Uninstall *.exe" }

    if ($exeCandidates.Count -ne 1) {
        $names = ($exeCandidates | Select-Object -ExpandProperty Name) -join ", "
        throw "Expected exactly one main exe in $ResolvedAppOutDir, found: $names"
    }

    return $exeCandidates[0].FullName
}

function Copy-BackWithRetry([string]$SourcePath, [string]$TargetPath) {
    for ($copyAttempt = 1; $copyAttempt -le 10; $copyAttempt++) {
        try {
            Copy-Item $SourcePath $TargetPath -Force
            return
        } catch {
            if ($copyAttempt -eq 10) {
                throw
            }
            Start-Sleep -Milliseconds ($copyAttempt * 300)
        }
    }
}

$resolvedProjectDir = (Resolve-Path $ProjectDir).Path
$resolvedAppOutDir = (Resolve-Path (Join-Path $resolvedProjectDir $AppOutDir)).Path
$iconPath = Join-Path $resolvedProjectDir "build\icon_ink_pen_256.ico"

if (-not (Test-Path $iconPath)) {
    throw "Icon not found: $iconPath"
}

$exePath = Resolve-MainExe $resolvedAppOutDir
$rceditPath = Resolve-RcEditPath

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-editor-rcedit-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$updated = $false

try {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $tempExe = Join-Path $tempRoot "novel-editor-desktop-$attempt.exe"
        Copy-Item $exePath $tempExe
        & $rceditPath $tempExe "--set-icon" $iconPath

        if ($LASTEXITCODE -eq 0) {
            Copy-BackWithRetry $tempExe $exePath
            $updated = $true
            break
        }

        if ($attempt -lt 5) {
            Start-Sleep -Milliseconds ($attempt * 400)
        }
    }

    if (-not $updated) {
        throw "rcedit failed to update icon for $exePath"
    }

    Write-Host "[fix-win-exe-icon] updated icon for $exePath"
} finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
