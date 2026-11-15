$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$out = Join-Path $root '.smoke/card-recovery.exe'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$refs = @('System.dll','System.Core.dll','Microsoft.CSharp.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll')
$compilerArgs = @('-nologo','-target:exe','-main:CardRecoveryTest', "-out:$out", "-lib:$framework/WPF") + @($refs | ForEach-Object { "-r:$_" }) + @((Join-Path $root 'helper\CuHelper.cs'), (Join-Path $root 'tests\card-recovery.cs'))
& "$framework/csc.exe" @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Card recovery fixture compilation failed' }
& $out
if ($LASTEXITCODE -ne 0) { throw 'Card recovery test failed' }

