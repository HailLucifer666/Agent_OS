param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]{1,100}$')][string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'pipe-server.cs') -ReferencedAssemblies 'System.Web.Extensions'
[MythosBrowserPipe]::Run($PipeName)
