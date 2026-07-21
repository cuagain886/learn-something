param(
    [string]$Javac = "javac",
    [string]$Java = "java",
    [string]$Javap = "javap"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "build\classes"

New-Item -ItemType Directory -Force -Path $output | Out-Null
$sources = Get-ChildItem -Path (Join-Path $root "examples") -Recurse -Filter *.java |
    Where-Object { $_.FullName -notlike "*object-layout*" } |
    ForEach-Object FullName

& $Javac --release 21 -g -parameters -d $output $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed: $LASTEXITCODE" }

$mains = @(
    "dev.deepjava.language.ValueSemanticsLab",
    "dev.deepjava.language.CollectionsMechanicsLab",
    "dev.deepjava.compiler.DesugaringLab",
    "dev.deepjava.bytecode.InvocationLab",
    "dev.deepjava.jvm.ClassInitializationLab",
    "dev.deepjava.concurrency.PublicationLab",
    "dev.deepjava.concurrency.ThreadAndLockLab",
    "dev.deepjava.concurrency.DeadlockLab",
    "dev.deepjava.concurrency.OneShotLatchLab",
    "dev.deepjava.concurrency.ExecutorBoundaryLab",
    "dev.deepjava.concurrency.VirtualThreadPinningLab"
    "dev.deepjava.runtime.ReflectionProxyLab"
    "dev.deepjava.io.NioProtocolLab"
    "dev.deepjava.io.FileChannelLab"
    "dev.deepjava.cache.CacheRaceLab"
    "dev.deepjava.distributed.FencedLockLab"
    "dev.deepjava.distributed.IdempotencyOutboxLab"
    "dev.deepjava.agent.SseParserLab"
    "dev.deepjava.agent.RagRetrievalLab"
    "dev.deepjava.agent.AgentStateMachineLab"
    "dev.deepjava.agent.ProcessSandboxLab"
)
foreach ($main in $mains) {
    & $Java -ea -cp $output $main
    if ($LASTEXITCODE -ne 0) { throw "$main failed: $LASTEXITCODE" }
}

$dump = Join-Path $root "build\InvocationLab.javap.txt"
& $Javap -classpath $output -c -v -p dev.deepjava.bytecode.InvocationLab |
    Set-Content -LiteralPath $dump -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw "javap failed: $LASTEXITCODE" }

Write-Host "Verified sources and wrote bytecode dump: $dump"
