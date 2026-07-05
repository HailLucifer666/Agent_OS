# Install abtop locally — no system PATH changes, no admin needed.
$ErrorActionPreference = 'Stop'
$zipUrl = 'https://github.com/graykode/abtop/releases/download/v0.5.1/abtop-x86_64-pc-windows-msvc.zip'
$installDir = Join-Path $pwd 'tools' | Join-Path -ChildPath 'abtop'
$zipPath = Join-Path $env:TEMP 'abtop-install.zip'

Write-Host "Downloading abtop..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

Write-Host "Extracting to $installDir ..."
if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
Remove-Item $zipPath -ErrorAction SilentlyContinue

$exe = Get-ChildItem -Path $installDir -Filter 'abtop.exe' -Recurse | Select-Object -First 1
if ($exe) {
    Write-Host "abtop installed: $($exe.FullName)"
    Write-Host "Verify: & `"$($exe.FullName)`" --version"
} else {
    Write-Error "abtop.exe not found after extraction"
}
