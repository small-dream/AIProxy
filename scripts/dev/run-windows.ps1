$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $scriptRoot "..\desktop.mjs") run --platform windows @args
