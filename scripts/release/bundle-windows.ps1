$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $scriptRoot "..\desktop.mjs") bundle --platform windows @args
