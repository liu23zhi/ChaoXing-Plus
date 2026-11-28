param([Parameter(Mandatory=$true)][string]$TiKuHelperRoot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or !$env:RUNNER_TEMP -or !$env:GITHUB_WORKSPACE) {
    throw 'Only the disposable ordinary Windows CI test runner may run this fixture.'
}

$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).ProviderPath
$providerRoot = (Resolve-Path -LiteralPath $TiKuHelperRoot).ProviderPath
$expected = Join-Path $workspace '.t04-owned-provider'
if ($providerRoot -ine $expected) { throw 'Expected the separate pinned T04 provider checkout.' }
$head = (& git -C $providerRoot rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or "$head".Trim() -cne '323227b75fa8ae2151a5f0cb361d1006a6c1aa2a') {
    throw 'Unexpected T04 provider revision.'
}

$dir = Join-Path $env:RUNNER_TEMP ('owned-t04-bin-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($dir) | Out-Null
$providerExe = Join-Path $dir 'provider.exe'
$nativeExe = Join-Path $dir 'native-host.exe'
$fixtures = Join-Path $PSScriptRoot 'ordinary-win-agreement'
$providerSource = Join-Path $providerRoot 'internal/controller/zz_owned_t04_provider_test.go'
if (Test-Path -LiteralPath $providerSource) { throw 'Refusing to overwrite provider source.' }

Copy-Item -LiteralPath (Join-Path $fixtures 'provider_test.go') -Destination $providerSource
try {
    Push-Location -LiteralPath $providerRoot
    try {
        & go test -p 2 -c -o $providerExe ./internal/controller
        if ($LASTEXITCODE -ne 0) { throw 'Could not compile the actual isolated provider fixture.' }
    } finally { Pop-Location }
    $hostSource = Join-Path $fixtures 'native-host.go'
    $hostTest = Join-Path $fixtures 'native-host_test.go'
    & go test -count=1 $hostSource $hostTest
    if ($LASTEXITCODE -ne 0) { throw 'Result-broker contract tests failed.' }
    & go build -trimpath -o $nativeExe $hostSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the test-only native host.' }

    $env:CX_T04_PROVIDER_EXE = $providerExe
    $env:CX_T04_NATIVE_EXE = $nativeExe
    & node --test (Join-Path $PSScriptRoot 'ordinary-win-agreement.browser.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Owned browser to native agreement test failed.' }
} finally {
    Remove-Item Env:\CX_T04_PROVIDER_EXE, Env:\CX_T04_NATIVE_EXE -ErrorAction SilentlyContinue
    foreach ($file in @($providerSource, $providerExe, $nativeExe)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file }
    }
}
