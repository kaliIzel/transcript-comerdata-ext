$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not $env:TRANSCRIPT_DATA) {
    $env:TRANSCRIPT_DATA = Join-Path $env:LOCALAPPDATA 'ComerdataTranscript'
}
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
$python = Join-Path $env:TRANSCRIPT_DATA 'venv\Scripts\python.exe'
$requirements = Get-FileHash -LiteralPath 'requirements.txt' -Algorithm SHA256
$stamp = Join-Path $env:TRANSCRIPT_DATA 'venv\requirements.sha256'

try {
    if (-not (Test-Path -LiteralPath $python)) {
        Write-Host 'Preparando el entorno de Python...'
        python -m venv (Join-Path $env:TRANSCRIPT_DATA 'venv')
        if ($LASTEXITCODE -ne 0) { throw 'Se necesita Python 3.10 o posterior para crear el entorno.' }
    }
    if (-not (Test-Path -LiteralPath $stamp) -or (Get-Content -LiteralPath $stamp -Raw).Trim() -ne $requirements.Hash) {
        Write-Host 'Instalando las dependencias locales...'
        & $python -m pip install --disable-pip-version-check -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar las dependencias de Transcript.' }
        Set-Content -LiteralPath $stamp -Value $requirements.Hash
    }

    $model = Join-Path $env:TRANSCRIPT_DATA 'models\whisper-base\model.bin'
    if (-not (Test-Path -LiteralPath $model)) {
        & $python local.py --prepare
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el modelo de Whisper.' }
    }
    & $python local.py
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
