param([string]$Javac = "javac", [string]$Java = "java", [string]$Jar = "jar")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$hostClasses = Join-Path $root "build\host"
$pluginBuild = Join-Path $root "build\plugins"
New-Item -ItemType Directory -Force -Path $hostClasses,$pluginBuild | Out-Null

$hostSources = @(
    Get-ChildItem -Path (Join-Path $root "api") -Recurse -Filter *.java
    Get-ChildItem -Path (Join-Path $root "host") -Recurse -Filter *.java
) | ForEach-Object FullName
& $Javac --release 21 -d $hostClasses $hostSources
if ($LASTEXITCODE -ne 0) { throw "host compilation failed" }

$jars = @()
foreach ($version in @("v1", "v2")) {
    $sourceRoot = Join-Path $root "plugins\$version"
    $classes = Join-Path $pluginBuild "$version-classes"
    $jarPath = Join-Path $pluginBuild "plugin-$version.jar"
    New-Item -ItemType Directory -Force -Path $classes | Out-Null
    $sources = Get-ChildItem -Path $sourceRoot -Recurse -Filter *.java | ForEach-Object FullName
    & $Javac --release 21 -cp $hostClasses -d $classes $sources
    if ($LASTEXITCODE -ne 0) { throw "$version compilation failed" }
    & $Jar --create --file $jarPath -C $classes . -C $sourceRoot META-INF/services
    if ($LASTEXITCODE -ne 0) { throw "$version jar failed" }
    $jars += $jarPath
}

& $Java -cp $hostClasses dev.deepjava.plugin.host.PluginHost $jars
if ($LASTEXITCODE -ne 0) { throw "plugin host failed" }
