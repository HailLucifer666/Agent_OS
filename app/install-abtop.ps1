# Install abtop on Windows
$ErrorActionPreference = 'Stop'
$zipUrl = 'https://github.com/graykode/abtop/releases/download/v0.5.1/abtop-x86_64-pc-windows-msvc.zip'
$installDir = Join-Path $env:LOCALAPPDATA 'abtop'
$zipPath = Join-Path $env:TEMP 'abtop-install.zip'

Write-Host "Downloading abtop..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

Write-Host "Extracting to $installDir ..."
if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
Expand-Archive -Path $zipPath -DestinationPath $installDir -Force

# Add to user PATH if not already present
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath -notsplit ';' | Where-Object { $_ -eq $installDir }) {
    [Environment]::SetEnvironmentVariable('Path', "$currentPath;$installDir", 'User')
    Write-Host "Added $installDir to user PATH."
}

Write-Host "abtop installed to $installDir"
Write-Host "Run: abtop --version"
