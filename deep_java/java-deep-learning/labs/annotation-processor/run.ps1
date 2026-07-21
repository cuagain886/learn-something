param([string]$Javac = "javac", [string]$Java = "java")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$processorClasses = Join-Path $root "build\processor"
$demoClasses = Join-Path $root "build\demo"
$generatedSources = Join-Path $root "build\generated"
New-Item -ItemType Directory -Force -Path $processorClasses,$demoClasses,$generatedSources | Out-Null

$processorSources = Get-ChildItem -Path (Join-Path $root "processor") -Recurse -Filter *.java |
    ForEach-Object FullName
& $Javac --release 21 -d $processorClasses $processorSources
if ($LASTEXITCODE -ne 0) { throw "processor compilation failed" }

$demoSources = Get-ChildItem -Path (Join-Path $root "demo") -Recurse -Filter *.java |
    ForEach-Object FullName
& $Javac --release 21 -cp $processorClasses -processorpath $processorClasses `
    -processor dev.deepjava.processor.GreetingProcessor `
    -s $generatedSources -d $demoClasses $demoSources
if ($LASTEXITCODE -ne 0) { throw "demo compilation failed" }

& $Java -cp $demoClasses dev.deepjava.demo.Demo
if ($LASTEXITCODE -ne 0) { throw "generated demo failed" }
Write-Host "Generated sources: $generatedSources"
