# 音声認識モデル (ReazonSpeech 日本語) を models/ に取得する。
#
#   .\scripts\setup-models.ps1
#
# 配布アーカイブには float32 版(約600MB)も入っているが、認識に使うのは
# int8 版なので展開後に消す。残るのは約160MB。

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$modelsDir = Join-Path $root "models"
$name = "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"
$destDir = Join-Path $modelsDir $name

# 実際に使うファイル (src/main.rs と一致させること)
$keep = @(
    "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.onnx",
    "joiner-epoch-99-avg-1.int8.onnx",
    "tokens.txt"
)

if (Test-Path $destDir) {
    $missing = $keep | Where-Object { -not (Test-Path (Join-Path $destDir $_)) }
    if ($missing.Count -eq 0) {
        Write-Host "モデルは配置済みです: $destDir"
        exit 0
    }
    Write-Host "不足しているファイルがあるので取得し直します: $($missing -join ', ')"
}

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$archive = Join-Path $modelsDir "$name.tar.bz2"
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name.tar.bz2"

Write-Host "ダウンロード中 (約720MB): $url"
curl.exe -L -o $archive $url

Write-Host "展開中..."
tar -xjf $archive -C $modelsDir
Remove-Item $archive

# 使わない float32 版・テスト用wavなどを削除して軽くする
Get-ChildItem $destDir -File -Recurse |
    Where-Object { $keep -notcontains $_.Name -and $_.Name -ne "README.md" } |
    Remove-Item -Force
Get-ChildItem $destDir -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$size = [math]::Round((Get-ChildItem $destDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "完了: $destDir ($size MB)"
