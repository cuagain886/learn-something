$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    mvn -q package
    if ($LASTEXITCODE -ne 0) { throw "JDBC pool build failed: $LASTEXITCODE" }
    mvn -q exec:java "-Dexec.mainClass=dev.deepjava.jdbc.JdbcPoolLab" "-Dexec.classpathScope=runtime"
    if ($LASTEXITCODE -ne 0) { throw "JDBC pool run failed: $LASTEXITCODE" }
} finally { Pop-Location }
