$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    mvn -q package
    if ($LASTEXITCODE -ne 0) { throw "Spring lab build failed: $LASTEXITCODE" }
    $mains = @(
        "dev.deepjava.spring.BeanLifecycleLab",
        "dev.deepjava.spring.TransactionBoundaryLab",
        "dev.deepjava.spring.AutoConfigurationLab",
        "dev.deepjava.spring.BootStartupLab",
        "dev.deepjava.spring.WebStackLab"
    )
    foreach ($main in $mains) {
        mvn -q exec:java "-Dexec.mainClass=$main" "-Dexec.classpathScope=runtime"
        if ($LASTEXITCODE -ne 0) { throw "$main failed: $LASTEXITCODE" }
    }
} finally {
    Pop-Location
}
