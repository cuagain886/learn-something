$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    mvn -q package
    if ($LASTEXITCODE -ne 0) { throw "Maven build failed: $LASTEXITCODE" }
    java -ea -cp target\reflection-agent-lab-1.0.0.jar dev.deepjava.agent.ByteBuddyProxyLab
    if ($LASTEXITCODE -ne 0) { throw "Byte Buddy proxy failed: $LASTEXITCODE" }
    java -ea "-javaagent:target\reflection-agent-lab-1.0.0.jar" -cp target\reflection-agent-lab-1.0.0.jar dev.deepjava.agent.AgentApplication
    if ($LASTEXITCODE -ne 0) { throw "Java agent run failed: $LASTEXITCODE" }
} finally {
    Pop-Location
}
