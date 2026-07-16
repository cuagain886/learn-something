param(
    [switch]$RequireKind
)

$results = [System.Collections.Generic.List[object]]::new()
$hasFailure = $false

function Add-Result {
    param(
        [string]$Name,
        [ValidateSet('PASS', 'WARN', 'FAIL')]
        [string]$Status,
        [string]$Detail
    )

    $script:results.Add([pscustomobject]@{
        Check  = $Name
        Status = $Status
        Detail = $Detail.Trim()
    })

    if ($Status -eq 'FAIL') {
        $script:hasFailure = $true
    }
}

function Invoke-NativeCheck {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    $output = & $Command @Arguments 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = (($output | ForEach-Object { $_.ToString() }) -join ' ').Trim()
    }
}

$wsl = Get-Command wsl -ErrorAction SilentlyContinue
if (-not $wsl) {
    Add-Result 'WSL' 'FAIL' 'wsl.exe was not found; the Docker Desktop WSL 2 backend is unavailable.'
} else {
    $check = Invoke-NativeCheck -Command 'wsl' -Arguments @('--version')
    if ($check.ExitCode -eq 0) {
        Add-Result 'WSL' 'PASS' 'wsl --version succeeded; run it interactively to record the exact version.'
    } else {
        Add-Result 'WSL' 'FAIL' "wsl --version failed: $($check.Output)"
    }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Add-Result 'Docker CLI' 'FAIL' 'The docker command was not found.'
    Add-Result 'Docker Engine' 'FAIL' 'The Engine cannot be checked without the Docker CLI.'
    Add-Result 'Docker Compose' 'FAIL' 'The Compose plugin cannot be checked without the Docker CLI.'
} else {
    $client = Invoke-NativeCheck -Command 'docker' -Arguments @('--version')
    if ($client.ExitCode -eq 0) {
        Add-Result 'Docker CLI' 'PASS' $client.Output
    } else {
        Add-Result 'Docker CLI' 'FAIL' $client.Output
    }

    $context = Invoke-NativeCheck -Command 'docker' -Arguments @('context', 'show')
    if ($context.ExitCode -eq 0) {
        Add-Result 'Docker context' 'PASS' $context.Output
    } else {
        Add-Result 'Docker context' 'FAIL' $context.Output
    }

    $server = Invoke-NativeCheck -Command 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}')
    if ($server.ExitCode -eq 0 -and $server.Output -match '^([^|]+)\|linux\|') {
        Add-Result 'Docker Engine' 'PASS' "server|os|arch = $($server.Output)"
    } elseif ($server.ExitCode -eq 0) {
        Add-Result 'Docker Engine' 'FAIL' "The Engine is reachable but is not using Linux containers: $($server.Output)"
    } else {
        Add-Result 'Docker Engine' 'FAIL' 'The Engine is unreachable; start Docker Desktop and check the active context.'
    }

    $compose = Invoke-NativeCheck -Command 'docker' -Arguments @('compose', 'version', '--short')
    if ($compose.ExitCode -eq 0) {
        Add-Result 'Docker Compose' 'PASS' $compose.Output
    } else {
        Add-Result 'Docker Compose' 'FAIL' $compose.Output
    }
}

$kubectl = Get-Command kubectl -ErrorAction SilentlyContinue
if (-not $kubectl) {
    Add-Result 'kubectl client' 'WARN' 'kubectl was not found; install it before lesson 11.'
} else {
    $check = Invoke-NativeCheck -Command 'kubectl' -Arguments @('version', '--client=true', '--output=json')
    if ($check.ExitCode -eq 0) {
        try {
            $version = ($check.Output | ConvertFrom-Json).clientVersion.gitVersion
        } catch {
            $version = $check.Output
        }
        Add-Result 'kubectl client' 'PASS' $version
    } else {
        Add-Result 'kubectl client' 'WARN' $check.Output
    }
}

$kind = Get-Command kind -ErrorAction SilentlyContinue
if (-not $kind) {
    if ($RequireKind) {
        Add-Result 'kind' 'FAIL' 'kind was not found and is required for the Kubernetes labs.'
    } else {
        Add-Result 'kind' 'WARN' 'Not installed; lessons 01-10 are unaffected. Install it before lesson 11.'
    }
} else {
    $check = Invoke-NativeCheck -Command 'kind' -Arguments @('version')
    if ($check.ExitCode -eq 0) {
        Add-Result 'kind' 'PASS' $check.Output
    } else {
        Add-Result 'kind' 'FAIL' $check.Output
    }
}

$results | Format-Table -AutoSize -Wrap

if ($hasFailure) {
    Write-Host 'Environment is not ready. Fix FAIL items before running labs.' -ForegroundColor Red
    exit 1
}

Write-Host 'Environment is ready for the requested course stage.' -ForegroundColor Green
exit 0
