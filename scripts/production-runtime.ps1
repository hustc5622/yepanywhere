$script:YepProductionManifestVersion = 2
$script:YepProductionStates = @('healthy', 'degraded-adoptable', 'verified-stale', 'unknown-conflict', 'stopped')

function Write-YepJsonAtomic {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $tempPath = "$Path.tmp.$([guid]::NewGuid().ToString('N'))"
  $backupPath = "$Path.bak.$([guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) {
      [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
    } else {
      [IO.File]::Move($tempPath, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupPath) {
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-YepBundleBuildId {
  param([Parameter(Mandatory = $true)][string]$BundlePath)
  $buildInfoPath = Join-Path $BundlePath 'build-info.json'
  $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$buildInfo.buildId)) { throw "Bundle build-info.json 缺少 buildId：$buildInfoPath" }
  return [string]$buildInfo.buildId
}

function Get-YepConfigFingerprint {
  param([Parameter(Mandatory = $true)]$ConfigIdentity)
  $bytes = [Text.Encoding]::UTF8.GetBytes(($ConfigIdentity | ConvertTo-Json -Compress -Depth 8))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Test-YepProperty {
  param($Value, [Parameter(Mandatory = $true)][string]$Name)
  return ($null -ne $Value) -and ($null -ne $Value.PSObject.Properties[$Name])
}

function Test-YepInteger {
  param($Value)
  return ($Value -is [byte]) -or ($Value -is [sbyte]) -or ($Value -is [int16]) -or
    ($Value -is [uint16]) -or ($Value -is [int32]) -or ($Value -is [uint32]) -or
    ($Value -is [int64]) -or ($Value -is [uint64])
}

function Test-YepUtcTimestamp {
  param($Value)
  if ([string]::IsNullOrWhiteSpace([string]$Value)) { return $false }
  try { [DateTimeOffset]::Parse([string]$Value) | Out-Null; return $true } catch { return $false }
}

function Test-YepProcessEntrySchema {
  param($Entry)
  if ($null -eq $Entry) { return $false }
  foreach ($name in @('Role', 'Pid', 'StartTimeUtc', 'ExecutablePath', 'CommandLine')) {
    if (-not (Test-YepProperty $Entry $name)) { return $false }
  }
  return (-not [string]::IsNullOrWhiteSpace([string]$Entry.Role)) -and
    (Test-YepInteger $Entry.Pid) -and [int64]$Entry.Pid -gt 0 -and
    (Test-YepUtcTimestamp $Entry.StartTimeUtc) -and
    -not [string]::IsNullOrWhiteSpace([string]$Entry.ExecutablePath) -and
    -not [string]::IsNullOrWhiteSpace([string]$Entry.CommandLine)
}

function Test-YepLegacyProcessEntrySchema {
  param($Entry)
  if ($null -eq $Entry) { return $false }
  foreach ($name in @('Role', 'Pid', 'StartTimeUtc')) {
    if (-not (Test-YepProperty $Entry $name)) { return $false }
  }
  return (-not [string]::IsNullOrWhiteSpace([string]$Entry.Role)) -and
    (Test-YepInteger $Entry.Pid) -and [int64]$Entry.Pid -gt 0 -and
    (Test-YepUtcTimestamp $Entry.StartTimeUtc)
}

function Test-YepManifestV1Schema {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ((-not (Test-YepProperty $Manifest 'Version')) -or (-not (Test-YepInteger $Manifest.Version)) -or
      ([int]$Manifest.Version -ne 1) -or ([string]$Manifest.Mode -cne 'prod') -or
      (-not (Test-YepProperty $Manifest 'Processes')) -or ($null -eq $Manifest.Processes)) { return $false }
  $roles = @()
  foreach ($entry in @($Manifest.Processes)) {
    if ((-not (Test-YepLegacyProcessEntrySchema $entry)) -or ($roles -contains [string]$entry.Role)) { return $false }
    $roles += [string]$entry.Role
  }
  return $roles.Count -gt 0
}

function Test-YepManifestV2Schema {
  param([Parameter(Mandatory = $true)]$Manifest)
  $required = @('Version', 'Mode', 'SupervisorInstanceId', 'Supervisor', 'BuildId',
    'ConfigFingerprint', 'RepoRoot', 'BundlePath', 'Profile', 'DataDir', 'BasePath',
    'Ports', 'Bridges', 'Processes')
  foreach ($name in $required) {
    if (-not (Test-YepProperty $Manifest $name)) { return $false }
  }
  if ((-not (Test-YepInteger $Manifest.Version)) -or ([int]$Manifest.Version -ne $script:YepProductionManifestVersion) -or
      ([string]$Manifest.Mode -cne 'prod') -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.SupervisorInstanceId) -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.BuildId) -or
      [string]$Manifest.ConfigFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.RepoRoot) -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.BundlePath) -or
      (($null -ne $Manifest.Profile) -and ($Manifest.Profile -isnot [string])) -or
      (($null -ne $Manifest.DataDir) -and ($Manifest.DataDir -isnot [string])) -or
      ($Manifest.BasePath -isnot [string])) { return $false }
  $instanceId = [guid]::Empty
  if (-not [guid]::TryParse([string]$Manifest.SupervisorInstanceId, [ref]$instanceId)) { return $false }
  if ((-not (Test-YepProcessEntrySchema $Manifest.Supervisor)) -or ([string]$Manifest.Supervisor.Role -cne 'supervisor')) { return $false }

  foreach ($name in @('Server', 'Maintenance', 'Codex', 'Claude')) {
    if ((-not (Test-YepProperty $Manifest.Ports $name)) -or (-not (Test-YepInteger $Manifest.Ports.$name)) -or
        ([int64]$Manifest.Ports.$name -lt 1) -or ([int64]$Manifest.Ports.$name -gt 65535)) { return $false }
  }
  if ([int64]$Manifest.Ports.Maintenance -ne ([int64]$Manifest.Ports.Server + 1)) { return $false }
  foreach ($name in @('Codex', 'Claude')) {
    if (-not (Test-YepProperty $Manifest.Bridges $name) -or
        @('managed', 'external', 'disabled') -cnotcontains [string]$Manifest.Bridges.$name) { return $false }
  }

  $roles = @()
  $pids = @([int64]$Manifest.Supervisor.Pid)
  foreach ($entry in @($Manifest.Processes)) {
    if ((-not (Test-YepProcessEntrySchema $entry)) -or
        @('server', 'codex-bridge', 'claude-bridge') -cnotcontains [string]$entry.Role -or
        $roles -ccontains [string]$entry.Role -or $pids -contains [int64]$entry.Pid) { return $false }
    $roles += [string]$entry.Role
    $pids += [int64]$entry.Pid
  }
  if (@($roles | Where-Object { $_ -ceq 'server' }).Count -ne 1) { return $false }
  foreach ($bridge in @(@('Codex', 'codex-bridge'), @('Claude', 'claude-bridge'))) {
    $count = @($roles | Where-Object { $_ -ceq $bridge[1] }).Count
    if ((([string]$Manifest.Bridges.($bridge[0]) -ceq 'managed') -and ($count -ne 1)) -or
        (([string]$Manifest.Bridges.($bridge[0]) -cne 'managed') -and ($count -ne 0))) { return $false }
  }
  return $true
}

function Read-YepProcessManifest {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ Status = 'missing'; Manifest = $null; Error = $null }
  }
  $manifest = $null
  try {
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-YepManifestV2Schema $manifest) {
      return [pscustomobject]@{ Status = 'valid-v2'; Manifest = $manifest; Error = $null }
    }
    if (Test-YepManifestV1Schema $manifest) {
      return [pscustomobject]@{ Status = 'valid-v1'; Manifest = $manifest; Error = $null }
    }
  } catch {
    return [pscustomobject]@{ Status = 'invalid'; Manifest = $manifest; Error = $_.Exception.Message }
  }
  return [pscustomobject]@{ Status = 'invalid'; Manifest = $manifest; Error = 'manifest-schema-invalid' }
}

function New-YepProcessIdentity {
  param([Parameter(Mandatory = $true)][string]$Role, [Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  try { $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch { return $null }
  if ((-not $cim) -or [string]::IsNullOrWhiteSpace([string]$cim.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace([string]$cim.CommandLine)) { return $null }
  return [ordered]@{
    Role = $Role
    Pid = $ProcessId
    StartTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
    ExecutablePath = [IO.Path]::GetFullPath([string]$cim.ExecutablePath)
    CommandLine = [string]$cim.CommandLine
  }
}

function Test-YepCommandToken {
  param($CommandLine, $Token)
  if ([string]::IsNullOrWhiteSpace([string]$CommandLine) -or
      [string]::IsNullOrWhiteSpace([string]$Token)) { return $false }
  $escapedToken = [regex]::Escape([string]$Token)
  $quote = [regex]::Escape([string][char]34)
  $pattern = '(?i)(?:^|\s)(?:' + $quote + $escapedToken + $quote + '|' +
    $escapedToken + ')(?=\s|$)'
  return [regex]::IsMatch([string]$CommandLine, $pattern)
}

function Test-YepRoleCommand {
  param([Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)]$Expectation)
  switch ($Role) {
    'supervisor' {
      return (Test-YepCommandToken $CommandLine $Expectation.RunScriptPath) -and
        (Test-YepCommandToken $CommandLine '-ConfigPath')
    }
    'server' {
      $portPattern = '(?i)(?:^|\s)--port(?:=|\s+)["'']?' +
        [regex]::Escape([string]$Expectation.ServerPort) + '(?=["'']?(?:\s|$))'
      return (Test-YepCommandToken $CommandLine $Expectation.CliPath) -and
        $CommandLine -match $portPattern
    }
    'codex-bridge' {
      return (Test-YepCommandToken $CommandLine $Expectation.CliPath) -and
        (Test-YepCommandToken $CommandLine '--codex-bridge-only')
    }
    'claude-bridge' {
      return (Test-YepCommandToken $CommandLine $Expectation.CliPath) -and
        (Test-YepCommandToken $CommandLine '--claude-bridge-only')
    }
    default { return $false }
  }
}

function Test-YepProcessIdentity {
  param([Parameter(Mandatory = $true)]$Entry, [Parameter(Mandatory = $true)]$Expectation)
  if (-not (Test-YepProcessEntrySchema $Entry)) { return $false }
  $current = New-YepProcessIdentity -Role ([string]$Entry.Role) -ProcessId ([int]$Entry.Pid)
  if ((-not $current) -or ([int]$current.Pid -ne [int]$Entry.Pid)) { return $false }
  try {
    $expectedStart = [DateTimeOffset]::Parse([string]$Entry.StartTimeUtc).UtcDateTime
    $currentStart = [DateTimeOffset]::Parse([string]$current.StartTimeUtc).UtcDateTime
    $storedPath = [IO.Path]::GetFullPath([string]$Entry.ExecutablePath)
  } catch { return $false }
  return ([Math]::Abs(($currentStart - $expectedStart).TotalSeconds) -le 1) -and
    [string]::Equals($storedPath, [string]$current.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$Entry.CommandLine, [string]$current.CommandLine, [StringComparison]::Ordinal) -and
    (Test-YepRoleCommand -Role ([string]$Entry.Role) -CommandLine ([string]$current.CommandLine) -Expectation $Expectation)
}

function Test-YepLegacyProcessIdentity {
  param([Parameter(Mandatory = $true)]$Entry, [Parameter(Mandatory = $true)]$Expectation)
  if (-not (Test-YepLegacyProcessEntrySchema $Entry)) { return $false }
  $current = New-YepProcessIdentity -Role ([string]$Entry.Role) -ProcessId ([int]$Entry.Pid)
  if (-not $current) { return $false }
  try {
    $expectedStart = [DateTimeOffset]::Parse([string]$Entry.StartTimeUtc).UtcDateTime
    $currentStart = [DateTimeOffset]::Parse([string]$current.StartTimeUtc).UtcDateTime
  } catch { return $false }
  return ([Math]::Abs(($currentStart - $expectedStart).TotalSeconds) -le 1) -and
    (Test-YepRoleCommand -Role ([string]$Entry.Role) -CommandLine ([string]$current.CommandLine) -Expectation $Expectation)
}

function Get-YepLegacyManifestPaths {
  param([Parameter(Mandatory = $true)]$Manifest)
  foreach ($name in @('RepoRoot', 'BundlePath')) {
    if ((-not (Test-YepProperty $Manifest $name)) -or ($Manifest.$name -isnot [string]) -or
        [string]::IsNullOrWhiteSpace([string]$Manifest.$name) -or
        [string]$Manifest.$name -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { return $null }
  }
  try {
    $repoRoot = [IO.Path]::GetFullPath([string]$Manifest.RepoRoot)
    $bundlePath = [IO.Path]::GetFullPath([string]$Manifest.BundlePath)
    $expectedBundlePath = [IO.Path]::GetFullPath((Join-Path $repoRoot 'dist/npm-package'))
  } catch { return $null }
  if (-not [string]::Equals($bundlePath, $expectedBundlePath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  return [pscustomobject]@{
    RepoRoot = $repoRoot
    BundlePath = $bundlePath
    RunScriptPath = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts/run-yepanywhere.ps1'))
    CliPath = [IO.Path]::GetFullPath((Join-Path $bundlePath 'dist/cli.js'))
  }
}

function New-YepProductionExpectation {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [Parameter(Mandatory = $true)][string]$BuildId,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$BasePath,
    [AllowNull()][string]$Profile,
    [AllowNull()][string]$DataDir,
    [AllowNull()][string]$AllowedImagePaths,
    [Parameter(Mandatory = $true)][int]$ServerPort,
    [Parameter(Mandatory = $true)][int]$MaintenancePort,
    [Parameter(Mandatory = $true)][int]$CodexPort,
    [Parameter(Mandatory = $true)][int]$ClaudePort,
    [Parameter(Mandatory = $true)][string]$CodexControlUrl,
    [Parameter(Mandatory = $true)][string]$ClaudeControlUrl,
    [Parameter(Mandatory = $true)][bool]$StartBridges,
    [Parameter(Mandatory = $true)][string]$RunScriptPath
  )
  if ([int64]$MaintenancePort -ne ([int64]$ServerPort + 1)) {
    throw 'MaintenancePort must equal ServerPort + 1.'
  }
  $normalizedRepoRoot = [IO.Path]::GetFullPath($RepoRoot)
  $normalizedBundlePath = [IO.Path]::GetFullPath($BundlePath)
  $normalizedBasePath = if ([string]::IsNullOrWhiteSpace($BasePath) -or ($BasePath -eq '/')) {
    ''
  } else {
    '/' + $BasePath.Trim('/')
  }
  $configIdentity = [ordered]@{
    RepoRoot = $normalizedRepoRoot
    BundlePath = $normalizedBundlePath
    BasePath = $normalizedBasePath
    Profile = $Profile
    DataDir = $DataDir
    AllowedImagePaths = $AllowedImagePaths
    ServerPort = $ServerPort
    MaintenancePort = $MaintenancePort
    CodexPort = $CodexPort
    ClaudePort = $ClaudePort
    CodexControlUrl = $CodexControlUrl
    ClaudeControlUrl = $ClaudeControlUrl
    StartBridges = $StartBridges
  }
  return [pscustomobject]@{
    RepoRoot = $normalizedRepoRoot
    BundlePath = $normalizedBundlePath
    BuildId = $BuildId
    BasePath = $normalizedBasePath
    Profile = $Profile
    DataDir = $DataDir
    AllowedImagePaths = $AllowedImagePaths
    ServerPort = $ServerPort
    MaintenancePort = $MaintenancePort
    CodexPort = $CodexPort
    ClaudePort = $ClaudePort
    CodexControlUrl = $CodexControlUrl
    ClaudeControlUrl = $ClaudeControlUrl
    StartBridges = $StartBridges
    RunScriptPath = [IO.Path]::GetFullPath($RunScriptPath)
    CliPath = [IO.Path]::GetFullPath((Join-Path $normalizedBundlePath 'dist/cli.js'))
    ServerBaseUrl = "http://127.0.0.1:${ServerPort}${normalizedBasePath}"
    ConfigIdentity = $configIdentity
    ConfigFingerprint = Get-YepConfigFingerprint -ConfigIdentity $configIdentity
  }
}

function Get-YepListeningPids {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  } catch {
    if ([string]$_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound,Get-NetTCPConnection') { return @() }
    return ,0
  }
  return @($connections | ForEach-Object {
      if (Test-YepProperty $_ 'OwningProcess') { [int]$_.OwningProcess } else { 0 }
    } | Sort-Object -Unique)
}

function Test-YepProcessDescendsFrom {
  param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][int]$AncestorId)
  $current = $ProcessId
  for ($depth = 0; ($depth -lt 32) -and ($current -gt 0); $depth++) {
    if ($current -eq $AncestorId) { return $true }
    try {
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop
    } catch { return $false }
    if ((-not $processInfo) -or (-not $processInfo.ParentProcessId)) { return $false }
    $current = [int]$processInfo.ParentProcessId
  }
  return $false
}

function Test-YepPortOwnerMatchesEntries {
  param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)]$Entries)
  if ($ProcessId -le 0) { return $false }
  foreach ($entry in @($Entries)) {
    if (($ProcessId -eq [int]$entry.Pid) -or (Test-YepProcessDescendsFrom -ProcessId $ProcessId -AncestorId ([int]$entry.Pid))) {
      return $true
    }
  }
  return $false
}

function Get-YepHttpProbe {
  param([Parameter(Mandatory = $true)][string]$Url, [switch]$ReadBuildId)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1 -ErrorAction Stop
    if ([int]$response.StatusCode -ne 200) { return [pscustomobject]@{ Healthy = $false; BuildId = $null } }
    if (-not $ReadBuildId) { return [pscustomobject]@{ Healthy = $true; BuildId = $null } }
    $body = [string]$response.Content | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$body.build.buildId)) {
      return [pscustomobject]@{ Healthy = $false; BuildId = $null }
    }
    return [pscustomobject]@{ Healthy = $true; BuildId = [string]$body.build.buildId }
  } catch {
    return [pscustomobject]@{ Healthy = $false; BuildId = $null }
  }
}

function Get-YepProductionInspection {
  param([Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)]$Expectation)
  $read = Read-YepProcessManifest -Path $ManifestPath
  $manifest = $read.Manifest
  $verifiedSupervisor = $null
  $verifiedProcesses = @()
  $reasons = @()
  $legacyInvalid = $false

  if ($read.Status -eq 'missing') { $reasons += 'manifest-missing' }
  elseif ($read.Status -eq 'invalid') { $reasons += 'manifest-invalid' }
  elseif ($read.Status -eq 'valid-v1') {
    $reasons += 'legacy-v1'
    $legacyPaths = Get-YepLegacyManifestPaths -Manifest $manifest
    if (-not $legacyPaths) {
      $legacyInvalid = $true
      $reasons += 'legacy-path-mismatch'
    } else {
      $legacyExpectation = [pscustomobject]@{
        RunScriptPath = $legacyPaths.RunScriptPath
        CliPath = $legacyPaths.CliPath
        ServerPort = [int]$Expectation.ServerPort
      }
      foreach ($entry in @($manifest.Processes)) {
        if (Test-YepLegacyProcessIdentity -Entry $entry -Expectation $legacyExpectation) {
          if ([string]$entry.Role -ceq 'supervisor') { $verifiedSupervisor = $entry }
          else { $verifiedProcesses += $entry }
        } else {
          $legacyInvalid = $true
          $reasons += 'process-identity-mismatch'
        }
      }
    }
  } elseif ($read.Status -eq 'valid-v2') {
    if (Test-YepProcessIdentity -Entry $manifest.Supervisor -Expectation $Expectation) {
      $verifiedSupervisor = $manifest.Supervisor
    } else {
      $reasons += 'supervisor-missing'
    }
    foreach ($entry in @($manifest.Processes)) {
      if (Test-YepProcessIdentity -Entry $entry -Expectation $Expectation) {
        $verifiedProcesses += $entry
      } else {
        $reasons += 'process-identity-mismatch'
      }
    }
  }

  $mainPids = @(Get-YepListeningPids -Port ([int]$Expectation.ServerPort))
  $maintenancePids = @(Get-YepListeningPids -Port ([int]$Expectation.MaintenancePort))
  $verifiedServers = @($verifiedProcesses | Where-Object { [string]$_.Role -ceq 'server' })
  $unknownPortOwners = @()
  foreach ($portInfo in @(
      [pscustomobject]@{ Port = [int]$Expectation.ServerPort; Pids = $mainPids },
      [pscustomobject]@{ Port = [int]$Expectation.MaintenancePort; Pids = $maintenancePids }
    )) {
    foreach ($ownerPid in @($portInfo.Pids)) {
      if (-not (Test-YepPortOwnerMatchesEntries -ProcessId ([int]$ownerPid) -Entries $verifiedServers)) {
        $unknownPortOwners += [pscustomobject]@{ Port = [int]$portInfo.Port; Pid = [int]$ownerPid }
      }
    }
  }
  if ($unknownPortOwners.Count -gt 0) { $reasons += 'unknown-port-owner' }

  $mainProbe = Get-YepHttpProbe -Url "$($Expectation.ServerBaseUrl)/api/version" -ReadBuildId
  $maintenanceProbe = Get-YepHttpProbe -Url "http://127.0.0.1:$($Expectation.MaintenancePort)/health"
  $mainHealthy = ($mainPids.Count -gt 0) -and
    ($unknownPortOwners.Port -notcontains [int]$Expectation.ServerPort) -and $mainProbe.Healthy
  $maintenanceHealthy = ($maintenancePids.Count -gt 0) -and
    ($unknownPortOwners.Port -notcontains [int]$Expectation.MaintenancePort) -and $maintenanceProbe.Healthy
  if (-not $mainHealthy) { $reasons += 'main-unhealthy' }
  if (-not $maintenanceHealthy) { $reasons += 'maintenance-unhealthy' }

  $bridgeHealthy = $true
  if ($read.Status -eq 'valid-v2') {
    foreach ($bridge in @(
        [pscustomobject]@{ Name = 'Codex'; Role = 'codex-bridge'; Port = [int]$Expectation.CodexPort; Url = [string]$Expectation.CodexControlUrl },
        [pscustomobject]@{ Name = 'Claude'; Role = 'claude-bridge'; Port = [int]$Expectation.ClaudePort; Url = [string]$Expectation.ClaudeControlUrl }
      )) {
      $mode = [string]$manifest.Bridges.($bridge.Name)
      if ($mode -ceq 'disabled') { continue }
      if ($mode -ceq 'managed') {
        $entries = @($verifiedProcesses | Where-Object { [string]$_.Role -ceq $bridge.Role })
        $owners = @(Get-YepListeningPids -Port $bridge.Port)
        if (($entries.Count -ne 1) -or ($owners.Count -eq 0)) { $bridgeHealthy = $false }
        foreach ($ownerPid in $owners) {
          if (-not (Test-YepPortOwnerMatchesEntries -ProcessId ([int]$ownerPid) -Entries $entries)) {
            $bridgeHealthy = $false
            $unknownPortOwners += [pscustomobject]@{ Port = [int]$bridge.Port; Pid = [int]$ownerPid }
          }
        }
      }
      $probe = Get-YepHttpProbe -Url ($bridge.Url.TrimEnd('/') + '/status')
      if (-not $probe.Healthy) { $bridgeHealthy = $false }
    }
    if (-not $bridgeHealthy) { $reasons += 'bridge-unhealthy' }
    foreach ($role in @('server')) {
      if (@($verifiedProcesses | Where-Object { [string]$_.Role -ceq $role }).Count -ne 1) { $reasons += 'role-missing' }
    }
    foreach ($bridge in @(@('Codex', 'codex-bridge'), @('Claude', 'claude-bridge'))) {
      if (([string]$manifest.Bridges.($bridge[0]) -ceq 'managed') -and
          (@($verifiedProcesses | Where-Object { [string]$_.Role -ceq $bridge[1] }).Count -ne 1)) { $reasons += 'role-missing' }
    }
    if (([string]$manifest.BuildId -cne [string]$Expectation.BuildId) -or
        ($mainProbe.BuildId -and ([string]$mainProbe.BuildId -cne [string]$Expectation.BuildId))) { $reasons += 'build-mismatch' }
    if ([string]$manifest.ConfigFingerprint -cne [string]$Expectation.ConfigFingerprint) { $reasons += 'config-mismatch' }
  }
  if ($unknownPortOwners.Count -gt 0) { $reasons += 'unknown-port-owner' }

  $hasVerified = ($null -ne $verifiedSupervisor) -or ($verifiedProcesses.Count -gt 0)
  if (($unknownPortOwners.Count -gt 0) -or $legacyInvalid -or
      (($read.Status -eq 'invalid') -and (($mainPids.Count -gt 0) -or ($maintenancePids.Count -gt 0)))) {
    $state = 'unknown-conflict'
  } elseif ((-not $hasVerified) -and ($mainPids.Count -eq 0) -and ($maintenancePids.Count -eq 0)) {
    $state = 'stopped'
  } elseif (($read.Status -eq 'valid-v1') -or ($read.Status -ne 'valid-v2') -or
      @($reasons | Where-Object { $_ -ne 'supervisor-missing' }).Count -gt 0) {
    $state = 'verified-stale'
  } elseif (-not $verifiedSupervisor) {
    $state = 'degraded-adoptable'
  } else {
    $state = 'healthy'
  }

  return [pscustomobject]@{
    State = $state
    Manifest = $manifest
    VerifiedSupervisor = $verifiedSupervisor
    VerifiedProcesses = @($verifiedProcesses)
    UnknownPortOwners = @($unknownPortOwners)
    MainHealthy = [bool]$mainHealthy
    MaintenanceHealthy = [bool]$maintenanceHealthy
    RunningBuildId = $mainProbe.BuildId
    Reasons = @($reasons | Select-Object -Unique)
  }
}

function Test-YepSnapshotDescendsFrom {
  param([Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][int]$AncestorId,
    [Parameter(Mandatory = $true)]$Processes)
  $current = $ProcessId
  for ($depth = 0; ($depth -lt 32) -and ($current -gt 0); $depth++) {
    if ($current -eq $AncestorId) { return $true }
    $currentInfo = @($Processes | Where-Object { [int]$_.ProcessId -eq $current }) | Select-Object -First 1
    if ((-not $currentInfo) -or (-not $currentInfo.ParentProcessId)) { return $false }
    $current = [int]$currentInfo.ParentProcessId
  }
  return $false
}

function Get-YepVerifiedProcessSnapshot {
  param([Parameter(Mandatory = $true)]$Entries)
  if (@($Entries).Count -eq 0) {
    return [pscustomobject]@{ Complete = $true; Processes = @(); Roots = @() }
  }
  try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  catch { return [pscustomobject]@{ Complete = $false; Processes = @(); Roots = @() } }

  foreach ($entry in @($Entries)) {
    if (@($processes | Where-Object { [int]$_.ProcessId -eq [int]$entry.Pid }).Count -eq 0) {
      return [pscustomobject]@{ Complete = $false; Processes = @(); Roots = @() }
    }
    $live = Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue
    try {
      $expectedStart = [DateTimeOffset]::Parse([string]$entry.StartTimeUtc).UtcDateTime
      $startMatches = $live -and
        ([Math]::Abs(($live.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -le 1)
    } catch { $startMatches = $false }
    if (-not $startMatches) {
      return [pscustomobject]@{ Complete = $false; Processes = @(); Roots = @() }
    }
  }

  $roots = @()
  foreach ($candidate in @($Entries)) {
    $isDescendant = $false
    foreach ($other in @($Entries)) {
      if (([int]$candidate.Pid -ne [int]$other.Pid) -and
          (Test-YepSnapshotDescendsFrom -ProcessId ([int]$candidate.Pid) -AncestorId ([int]$other.Pid) -Processes $processes)) {
        $isDescendant = $true
        break
      }
    }
    if (-not $isDescendant) { $roots += $candidate }
  }

  $candidatePids = @($Entries | ForEach-Object { [int]$_.Pid })
  foreach ($processInfo in $processes) {
    foreach ($root in $roots) {
      if (Test-YepSnapshotDescendsFrom -ProcessId ([int]$processInfo.ProcessId) -AncestorId ([int]$root.Pid) -Processes $processes) {
        $candidatePids += [int]$processInfo.ProcessId
        break
      }
    }
  }
  $snapshot = @()
  foreach ($processId in @($candidatePids | Sort-Object -Unique)) {
    $live = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($live) {
      $snapshot += [pscustomobject]@{
        Pid = [int]$processId
        StartTimeUtc = $live.StartTime.ToUniversalTime().ToString('o')
      }
    }
  }
  return [pscustomobject]@{ Complete = $true; Processes = @($snapshot); Roots = @($roots) }
}

function Test-YepSnapshotProcessAlive {
  param([Parameter(Mandatory = $true)]$Entry)
  $live = Get-Process -Id ([int]$Entry.Pid) -ErrorAction SilentlyContinue
  if (-not $live) { return $false }
  try {
    $expectedStart = [DateTimeOffset]::Parse([string]$Entry.StartTimeUtc).UtcDateTime
    return [Math]::Abs(($live.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -le 1
  } catch { return $true }
}

function Get-YepRemainingSnapshotPids {
  param([Parameter(Mandatory = $true)]$Snapshot)
  return @($Snapshot | Where-Object { Test-YepSnapshotProcessAlive $_ } |
      ForEach-Object { [int]$_.Pid } | Sort-Object -Unique)
}

function Invoke-YepTaskkillTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& taskkill.exe /PID $ProcessId /T /F 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in $output) { Write-Host $line }
  return [pscustomobject]@{ ExitCode = [int]$exitCode }
}

function Stop-YepVerifiedProcessGroup {
  param([Parameter(Mandatory = $true)]$Inspection, [int]$ExcludeProcessId)
  if (@($Inspection.UnknownPortOwners).Count -gt 0) { return $false }
  $entries = @()
  if ($Inspection.VerifiedSupervisor) { $entries += $Inspection.VerifiedSupervisor }
  $entries += @($Inspection.VerifiedProcesses)
  if ($PSBoundParameters.ContainsKey('ExcludeProcessId')) {
    $entries = @($entries | Where-Object { [int]$_.Pid -ne $ExcludeProcessId })
  }
  if ($entries.Count -eq 0) { return $true }

  $snapshotResult = Get-YepVerifiedProcessSnapshot -Entries $entries
  if (-not $snapshotResult.Complete) { return $false }
  $snapshot = @($snapshotResult.Processes)
  $failed = $false
  foreach ($root in @($snapshotResult.Roots)) {
    $snapshotEntry = @($snapshot | Where-Object { [int]$_.Pid -eq [int]$root.Pid }) | Select-Object -First 1
    if ((-not $snapshotEntry) -or (-not (Test-YepSnapshotProcessAlive $snapshotEntry))) { continue }
    $kill = Invoke-YepTaskkillTree -ProcessId ([int]$root.Pid)
    $stillAlive = Test-YepSnapshotProcessAlive $snapshotEntry
    if (($kill.ExitCode -ne 0) -and $stillAlive) { $failed = $true }
  }

  foreach ($processId in @(Get-YepRemainingSnapshotPids -Snapshot $snapshot)) {
    $snapshotEntry = @($snapshot | Where-Object { [int]$_.Pid -eq [int]$processId }) | Select-Object -First 1
    if ((-not $snapshotEntry) -or (-not (Test-YepSnapshotProcessAlive $snapshotEntry))) { continue }
    $kill = Invoke-YepTaskkillTree -ProcessId $processId
    $stillAlive = Test-YepSnapshotProcessAlive $snapshotEntry
    if (($kill.ExitCode -ne 0) -and $stillAlive) { $failed = $true }
  }
  $remaining = @(Get-YepRemainingSnapshotPids -Snapshot $snapshot)
  return (-not $failed) -and ($remaining.Count -eq 0)
}
