<#
  Downloads the third-party libraries and the two detector models into a local vendor\ folder, so the
  web app can start WITHOUT the internet (see js\vendor-assets.js). Run it once on a PC that has internet,
  where the web app is served from (default C:\follow-app).

    powershell -ExecutionPolicy Bypass -File tools\fetch-vendor.ps1
    powershell -ExecutionPolicy Bypass -File tools\fetch-vendor.ps1 -Target D:\app\vendor

  What it writes (paths are relative to the target folder):
    mediapipe\vision_bundle.mjs, mediapipe\wasm\*          MediaPipe tasks-vision
    onnxruntime\ort.wasm.min.mjs, onnxruntime\ort-wasm*    ONNX Runtime Web (WASM only)
    models\efficientdet_lite0.tflite                       person detector
    models\blaze_face_short_range.tflite                   face detector
    vendor-manifest.json                                   what the page reads to decide local vs CDN

  Versions MUST match the code (MEDIAPIPE_VERSION in js\ai-owner.js, ORT_VERSION in
  js\embedding\embedding-engine.js); a different version in the manifest is ignored by the page.
  NOT tested on a real PC by the author of this script: read the summary at the end.
#>
param(
  [string]$Target = "C:\follow-app\vendor",
  [string]$MediapipeVersion = "0.10.35",
  [string]$OrtVersion = "1.31.1",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"      # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$files = @{ mediapipe = @(); onnxruntime = @(); models = @() }
$failed = @()

function Get-PackageFiles([string]$package, [string]$version) {
  # jsDelivr lists every file of an npm package version.
  $url = "https://data.jsdelivr.com/v1/packages/npm/${package}@${version}?structure=flat"
  try {
    $listing = Invoke-RestMethod -Uri $url
    return @($listing.files | ForEach-Object { $_.name })
  } catch {
    Write-Warning "Could not read the file list of $package@$version ($($_.Exception.Message))."
    return $null
  }
}

function Save-File([string]$url, [string]$relativePath, [string]$component) {
  $relativePath = $relativePath -replace "\\", "/"
  $destination = Join-Path $Target ($relativePath -replace "/", "\")
  $folder = Split-Path $destination -Parent
  if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
  try {
    if ($Force -or -not (Test-Path $destination) -or (Get-Item $destination).Length -eq 0) {
      Write-Host "  downloading $relativePath"
      Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
    } else {
      Write-Host "  have        $relativePath (use -Force to download again)"
    }
    $item = Get-Item $destination
    if ($item.Length -eq 0) { throw "the downloaded file is empty" }
    $hash = (Get-FileHash -Path $destination -Algorithm SHA256).Hash.ToLower()
    $script:files[$component] += [pscustomobject]@{ path = $relativePath; bytes = $item.Length; sha256 = $hash }
  } catch {
    Write-Warning "FAILED $relativePath : $($_.Exception.Message)"
    $script:failed += $relativePath
  }
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null
Write-Host "Target folder: $Target"

# ---- MediaPipe tasks-vision ------------------------------------------------------------------
Write-Host "`nMediaPipe tasks-vision $MediapipeVersion"
$mpBase = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$MediapipeVersion"
$mpList = Get-PackageFiles "@mediapipe/tasks-vision" $MediapipeVersion
if ($mpList) {
  $mpWanted = @($mpList | Where-Object { $_ -eq "/vision_bundle.mjs" -or ($_ -like "/wasm/*" -and $_ -notlike "*.map") })
} else {
  Write-Warning "Using a built-in file list for MediaPipe; it may be incomplete for this version."
  $mpWanted = @("/vision_bundle.mjs", "/wasm/vision_wasm_internal.js", "/wasm/vision_wasm_internal.wasm",
                "/wasm/vision_wasm_nosimd_internal.js", "/wasm/vision_wasm_nosimd_internal.wasm")
}
foreach ($name in $mpWanted) { Save-File "$mpBase$name" ("mediapipe" + $name) "mediapipe" }

# ---- ONNX Runtime Web (WASM only; the WebGPU/JSEP builds are not used) -------------------------
Write-Host "`nONNX Runtime Web $OrtVersion"
$ortBase = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$OrtVersion/dist"
$ortList = Get-PackageFiles "onnxruntime-web" $OrtVersion
if ($ortList) {
  $ortWanted = @($ortList | Where-Object {
    $_ -eq "/dist/ort.wasm.min.mjs" -or
    ($_ -match "^/dist/ort-wasm[^/]*\.(mjs|wasm)$" -and $_ -notmatch "jsep|asyncify")
  })
} else {
  Write-Warning "Using a built-in file list for ONNX Runtime; it may be incomplete for this version."
  $ortWanted = @("/dist/ort.wasm.min.mjs", "/dist/ort-wasm-simd-threaded.mjs", "/dist/ort-wasm-simd-threaded.wasm")
}
foreach ($name in $ortWanted) { Save-File "$ortBase/$($name.Substring(6))" ("onnxruntime/" + $name.Substring(6)) "onnxruntime" }

# ---- detector models ---------------------------------------------------------------------------
Write-Host "`nDetector models"
Save-File "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite" "models/efficientdet_lite0.tflite" "models"
Save-File "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite" "models/blaze_face_short_range.tflite" "models"

# ---- manifest ----------------------------------------------------------------------------------
if ($failed.Count -gt 0) {
  Write-Host "`nSome files failed, so NO manifest was written (the page keeps using the CDN):"
  $failed | ForEach-Object { Write-Host "  $_" }
  exit 1
}

$manifest = [ordered]@{
  format = 1
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  components = [ordered]@{
    mediapipe = [ordered]@{ version = $MediapipeVersion; files = @($files.mediapipe) }
    onnxruntime = [ordered]@{ version = $OrtVersion; files = @($files.onnxruntime) }
    models = [ordered]@{ files = @($files.models) }
  }
}
$json = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $Target "vendor-manifest.json"), $json, (New-Object Text.UTF8Encoding($false)))

$total = 0
foreach ($component in $files.Keys) { foreach ($f in $files[$component]) { $total += $f.bytes } }
Write-Host ("`nDone: {0} files, {1:N1} MB in {2}" -f (($files.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum), ($total / 1MB), $Target)
Write-Host "Reload the page: the PERSON DETECTION card should show 'LIB LOCAL'."
