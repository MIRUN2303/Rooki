# Installs the Parakeet speech-to-text stack entirely inside tools/ (no C: disk pollution).
# Usage:  powershell -ExecutionPolicy Bypass -File tools/setup.ps1
$ErrorActionPreference = "Stop"
$venv = Join-Path $PSScriptRoot "venv"
$py = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "Creating venv at $venv ..."
    python -m venv $venv
}

Write-Host "Installing pip packages (torch + NeMo, ~1.5GB download, first run takes a while) ..."
& $py -m pip install --upgrade pip
& $py -m pip install "nemo_toolkit[asr]" fastapi uvicorn

Write-Host ""
Write-Host "Downloading Parakeet model (~2.4GB) into tools\models ..."
& $py -c "import os; os.environ['NEMO_CACHE_DIR']=os.path.join(os.getcwd(),'tools','models'); import nemo.collections.asr as n; n.models.ASRModel.from_pretrained('nvidia/parakeet-tdt-0.6b-v2')"

Write-Host ""
Write-Host "Done. Start the server with:  tools\venv\Scripts\python.exe stt_server.py"