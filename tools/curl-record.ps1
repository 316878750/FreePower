# 生成真实 curl 实测记录：起独立数据目录的 FreePower，用系统 curl.exe 逐条打。
# 超长响应（create/start/active/list）用 -Shape 裁成关键字段，其余原样；裁剪只影响展示。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$base = 'http://127.0.0.1:53417'
$dataDir = Join-Path $root 'data-curl'
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
$outDir = Join-Path $root 'artifacts'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$transcript = Join-Path $outDir 'curl-transcript.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($transcript, "# FreePower curl 实测记录`n# $(Get-Date -Format o)  data=$dataDir`n`n", $utf8)

function SaveNote([string]$text) {
  [System.IO.File]::AppendAllText($transcript, "$text`n`n", $utf8)
}

function Req([string]$note, [string[]]$argv, [switch]$Raw, [scriptblock]$Shape) {
  $shown = 'curl -s ' + ($argv -join ' ')
  $out = (& curl.exe -s @argv 2>&1) -join "`n"
  if (-not $Raw) {
    try {
      $j = $out | ConvertFrom-Json
      if ($Shape) { $j = & $Shape $j }
      $out = ($j | ConvertTo-Json -Depth 8)
    } catch { }
  }
  [System.IO.File]::AppendAllText($transcript, "# $note`n`$ $shown`n$out`n`n", $utf8)
  return $out
}

function Body([string]$name, [string]$json) {
  $p = Join-Path $outDir "body-$name.json"
  [System.IO.File]::WriteAllText($p, $json, $utf8)
  return "@$p"
}

$ShapeStart = {
  param($j)
  [pscustomobject]@{
    code = $j.code; msg = $j.msg
    data = [pscustomobject]@{
      pid = $j.data.pid; debug_port = $j.data.debug_port; ws = $j.data.ws
      status = $j.data.status; already_running = $j.data.already_running
      real_version = $j.data.real_version
      selfcheck = [pscustomobject]@{ ok = $j.data.selfcheck.ok; score = $j.data.selfcheck.score; pass = $j.data.selfcheck.pass; warn = $j.data.selfcheck.warn; fail = $j.data.selfcheck.fail }
    }
  }
}

$env:FREEPOWER_DATA = $dataDir
$env:FREEPOWER_PORT = '53417'
$srv = Start-Process -FilePath 'node' -ArgumentList '--no-warnings','src/main.js' -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 300
    try {
      $r = & curl.exe -s --max-time 2 "$base/status"
      if ($r -match '"code":0') { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw '服务没起来' }

  $apiKey = (Select-String -Path (Join-Path $dataDir 'local_api') -Pattern 'api_key=(.*)').Matches[0].Groups[1].Value
  SaveNote "# api_key 从 data/local_api 读（前 12 位）：$($apiKey.Substring(0,12))..."
  $H = @('-H', "api-key: $apiKey", '-H', 'content-type: application/json')
  $M = @('-H', 'x-freepower-client: mcp')

  SaveNote '## 1. 探活 + 鉴权'
  Req '/status：免鉴权、不限流' @("$base/status") | Out-Null
  Req '无 key 调环境列表 → HTTP 401' @("$base/api/v1/user/list", '-o', 'NUL', '-w', '%{http_code}') -Raw | Out-Null

  SaveNote '## 2. 建 3 个环境（响应裁成关键字段）'
  $ids = @()
  $ShapeCreate = {
    param($j)
    [pscustomobject]@{ code=$j.code; msg=$j.msg; data=[pscustomobject]@{ profile_id=$j.data.profile_id; profile_no=$j.data.profile_no; name=$j.data.name; ua=$j.data.ua; timezone=$j.data.timezone; kernel_version=$j.data.kernel_version } }
  }
  foreach ($n in @('curl-a','curl-b','curl-c')) {
    $b = Body "create-$n" "{`"name`":`"$n`",`"country`":`"US`",`"group_id`":`"0`"}"
    $out = Req "建 $n" (@('-X','POST',"$base/api/v1/user/create") + $H + $M + @('-d', $b)) -Shape $ShapeCreate
    $ids += ($out | ConvertFrom-Json).data.profile_id
  }
  SaveNote "三个环境 id：$($ids -join ' , ')"

  SaveNote '## 3. 起 1 个 + 批量起 3 个'
  Req '单环境启动' (@("$base/api/v1/browser/start?user_id=$($ids[0])") + $H + $M) -Shape $ShapeStart
  $b = Body 'batch-start' ('{"user_ids":["' + ($ids -join '","') + '"],"concurrency":3}')
  Req '批量起 3 个（先起的那个算 already_running）' (@('-X','POST',"$base/api/v1/browser/batch-start") + $H + $M + @('-d', $b))

  SaveNote '## 4. 幂等重复 start'
  Req '重复 start：同一 pid / 同一 ws，already_running=true' (@("$base/api/v1/browser/start?user_id=$($ids[0])") + $H + $M) -Shape $ShapeStart

  SaveNote '## 5. active / local-active'
  Req 'active：开着' (@("$base/api/v1/browser/active?user_id=$($ids[0])") + $H + $M) -Shape $ShapeStart
  $ShapeLocal = {
    param($j)
    [pscustomobject]@{ code=$j.code; msg=$j.msg; data=[pscustomobject]@{ count=$j.data.list.Count; list=@($j.data.list | ForEach-Object { [pscustomobject]@{ profile_id=$_.profile_id; pid=$_.pid; status=$_.status; ws=$_.ws.puppeteer } }) } }
  }
  Req 'local-active：本机已开环境' (@("$base/api/v1/browser/local-active") + $H + $M) -Shape $ShapeLocal

  SaveNote '## 6. 批量停'
  $b = Body 'batch-stop' ('{"profile_ids":["' + ($ids -join '","') + '"],"concurrency":5}')
  Req '批量停 3 个' (@('-X','POST',"$base/api/v2/browser-profile/batch-stop") + $H + $M + @('-d', $b))
  Req 'active：停掉后 Inactive' (@("$base/api/v1/browser/active?user_id=$($ids[0])") + $H + $M)

  SaveNote '## 7. 错误码'
  Req '100001 环境不存在' (@("$base/api/v1/browser/start?user_id=not-exist") + $H + $M)
  Req '100002 缺 id' (@("$base/api/v1/browser/active") + $H + $M)
  Req '800002 环境没在运行' (@("$base/api/v1/browser/stop?user_id=$($ids[0])") + $H + $M)
  Req '100002 内核类型非法' (@("$base/api/v2/browser-profile/kernels?kernel_type=opera") + $H + $M)
  $b = Body 'cloud' ('{"user_ids":"' + ($ids -join ',') + '"}')
  Req 'cloud-active：明确报不支持，不假成功' (@('-X','POST',"$base/api/v1/browser/cloud-active") + $H + $M + @('-d', $b))
  $b = Body 'recycle' '{"page":1}'
  Req '未实现接口：明确不支持（-1 + supported:false）' (@('-X','POST',"$base/api/v2/browser-profile/recycle-bin/list") + $H + $M + @('-d', $b))

  SaveNote '## 8. 限流（不带 mcp 头，默认 1 次/秒）'
  $ShapeList1 = { param($j) [pscustomobject]@{ code=$j.code; msg=$j.msg; total=$j.data.total; returned=@($j.data.list).Count } }
  Req '第 1 次：正常' (@("$base/api/v1/user/list") + $H) -Shape $ShapeList1
  Req '第 2 次（同一秒内）：命中限流，报文逐字对齐对手' (@("$base/api/v1/user/list") + $H)

  SaveNote '## 9. CORS'
  Req '非白名单 Origin：403 + 纯文本 CORS ERROR' @("$base/status", '-i', '-H', 'Origin: https://evil.example') -Raw | Out-Null

  SaveNote '## 10. 其它本地组装路由'
  Req 'cookies' (@("$base/api/v2/browser-profile/cookies?profile_id=$($ids[0])") + $H + $M)
  Req 'kernels' (@("$base/api/v2/browser-profile/kernels?kernel_type=chrome") + $H + $M)
  $ShapeList = {
    param($j)
    [pscustomobject]@{ code=$j.code; msg=$j.msg; data=[pscustomobject]@{ total=$j.data.total; limit=$j.data.limit; list=@($j.data.list | ForEach-Object { [pscustomobject]@{ profile_id=$_.profile_id; name=$_.name; serial_number=$_.serial_number; batch_id=$_.batch_id } }) } }
  }
  $b = Body 'list' '{"limit":10}'
  Req 'v2 list' (@('-X','POST',"$base/api/v2/browser-profile/list") + $H + $M + @('-d', $b)) -Shape $ShapeList
}
finally {
  try { [System.IO.File]::AppendAllText($transcript, "`n# 记录结束`n", $utf8) } catch { }
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
}