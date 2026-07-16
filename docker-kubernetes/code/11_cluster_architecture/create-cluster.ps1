param(
    [string]$Name = 'dk-course'
)

$ErrorActionPreference = 'Stop'
$nodeImage = 'kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f'
$config = Join-Path $PSScriptRoot 'kind-config.yaml'

foreach ($command in @('docker', 'kind', 'kubectl')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command was not found in PATH"
    }
}

docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Engine is not reachable'
}

$existing = kind get clusters
if ($existing -contains $Name) {
    throw "kind cluster '$Name' already exists; inspect or delete it explicitly"
}

kind create cluster --name $Name --image $nodeImage --config $config --wait 120s
if ($LASTEXITCODE -ne 0) {
    throw 'kind cluster creation failed'
}

kubectl config use-context "kind-$Name" | Out-Null
kubectl wait --for=condition=Ready nodes --all --timeout=120s
kubectl get nodes -o wide
