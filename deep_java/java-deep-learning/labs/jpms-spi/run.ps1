$ErrorActionPreference = "Stop"
$build = Join-Path $PSScriptRoot "build"
$mods = Join-Path $build "mods"
New-Item -ItemType Directory -Force -Path $mods | Out-Null

$sources = Get-ChildItem -Recurse -File -Path (Join-Path $PSScriptRoot "src") -Filter *.java | ForEach-Object FullName
javac --release 21 -d $mods --module-source-path (Join-Path $PSScriptRoot "src") $sources
if ($LASTEXITCODE -ne 0) { throw "JPMS compilation failed" }

java --module-path $mods -m com.deepjava.plugin.host/dev.deepjava.plugin.host.PluginHost
if ($LASTEXITCODE -ne 0) { throw "JPMS ServiceLoader run failed" }
