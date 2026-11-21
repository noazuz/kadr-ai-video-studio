# SET API KEY ----- 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-replicate-token.ps1'




$ErrorActionPreference = 'Stop'

if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is unavailable.'
}

$secret = Read-Host 'Paste your Replicate API token' -AsSecureString
try {
    if ($secret.Length -eq 0) {
        throw 'Token is empty. The saved token was not changed.'
    }

    $directory = Join-Path $env:LOCALAPPDATA 'Kadr'
    $destination = Join-Path $directory 'replicate-token.dpapi'
    $temporary = Join-Path $directory ([Guid]::NewGuid().ToString() + '.dpapi')
    New-Item -ItemType Directory -Path $directory -Force | Out-Null

    try {
        $encrypted = ConvertFrom-SecureString -SecureString $secret
        [IO.File]::WriteAllText($temporary, $encrypted)
        if ([IO.File]::Exists($destination)) {
            [IO.File]::Replace($temporary, $destination, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $destination)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) {
            [IO.File]::Delete($temporary)
        }
    }
} finally {
    $secret.Dispose()
}

Write-Host 'Replicate token saved for this Windows user.'
