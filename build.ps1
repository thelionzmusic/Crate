# Builds dist\Crate\Crate.exe. Run via build.bat (double-click).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-Python {
    foreach ($cmd in @("py -3.12", "py -3.13", "py -3", "python")) {
        $parts = $cmd.Split(" ")
        try {
            $v = & $parts[0] $parts[1..9] -c "import sys; print(sys.version_info >= (3, 10))" 2>$null
            if ($v -eq "True") { return $parts }
        } catch {}
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Host "Python 3.10+ not found. Installing Python 3.12 with winget..."
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $py = Find-Python
    if (-not $py) { throw "Python install didn't take. Install 3.12 from python.org (tick 'Add to PATH') and run build.bat again." }
}

Write-Host "Setting up build environment..."
& $py[0] $py[1..9] -m venv .venv
$venvPy = ".venv\Scripts\python.exe"
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install --quiet -r requirements.txt

if (-not (Test-Path "bin\ffmpeg.exe") -or -not (Test-Path "bin\ffprobe.exe")) {
    Write-Host "Downloading ffmpeg (decoding and lossless conversion)..."
    New-Item -ItemType Directory -Force bin | Out-Null
    $zip = Join-Path $env:TEMP "crate-ffmpeg.zip"
    $tmp = Join-Path $env:TEMP "crate-ffmpeg"
    Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp -Force
    $binDir = (Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).Directory.FullName
    Copy-Item "$binDir\ffmpeg.exe", "$binDir\ffprobe.exe" bin\
    Remove-Item $zip, $tmp -Recurse -Force
}

Write-Host "Running tests..."
$env:PATH = "$PSScriptRoot\bin;$env:PATH"
& $venvPy tests\test_analysis.py
if ($LASTEXITCODE -ne 0) { throw "Analysis tests failed." }
& $venvPy tests\test_export.py
if ($LASTEXITCODE -ne 0) { throw "Export tests failed." }

# A running Crate (or its analysis workers) locks the files the build replaces.
Get-Process -Name Crate -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# The native audio engine needs CMake and Visual Studio's C++ tools; without them Crate
# still builds and Perform uses the browser engine.
$engineArgs = @()
if (Get-Command cmake -ErrorAction SilentlyContinue) {
    Write-Host "Building the native audio engine..."
    cmake -S native -B native\build -A x64 | Out-Null
    cmake --build native\build --config Release --parallel | Out-Null
    if ($LASTEXITCODE -eq 0 -and (Test-Path native\build\Release\crate-engine.exe)) {
        New-Item -ItemType Directory -Force crate\bin | Out-Null
        Copy-Item native\build\Release\crate-engine.exe crate\bin\
        $engineArgs = @("--add-binary", "crate\bin\crate-engine.exe;crate\bin")
    } else { Write-Host "Native engine build failed; continuing without it." -ForegroundColor Yellow }
} else { Write-Host "CMake not found: skipping the native audio engine." -ForegroundColor Yellow }

Write-Host "Building Crate.exe..."
& $venvPy -m PyInstaller --noconfirm --clean --windowed --name Crate `
    --icon crate\web\icon.ico `
    --add-data "crate\web;crate\web" `
    --add-data "crate\export\templates;crate\export\templates" `
    --add-binary "bin\ffmpeg.exe;bin" --add-binary "bin\ffprobe.exe;bin" `
    --exclude-module tkinter --exclude-module matplotlib `
    @engineArgs `
    run_crate.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut("$desktop\Crate.lnk")
$lnk.TargetPath = "$PSScriptRoot\dist\Crate\Crate.exe"
$lnk.WorkingDirectory = "$PSScriptRoot\dist\Crate"
$lnk.IconLocation = "$PSScriptRoot\dist\Crate\Crate.exe"
$lnk.Save()

Write-Host ""
Write-Host "Done: dist\Crate\Crate.exe (shortcut added to your desktop)." -ForegroundColor Green
