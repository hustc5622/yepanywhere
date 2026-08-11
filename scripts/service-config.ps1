function Test-ServicePortValue($value) {
  if (-not ($value -is [string] -or $value -is [int] -or $value -is [long])) {
    return $false
  }
  $parsed = 0
  return [int]::TryParse([string]$value, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535
}

function Test-NullableServiceString($value) {
  if ($null -eq $value) { return $true }
  return $value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)
}

function Test-ServiceConfigSchema($config) {
  if ($null -eq $config -or $config -is [array]) { return $false }
  $required = @("Version", "ServerPort", "BasePath", "Profile", "DataDir", "AllowedImagePaths", "CodexPort", "ClaudePort")
  foreach ($propertyName in $required) {
    if ($config.PSObject.Properties.Name -notcontains $propertyName) { return $false }
  }
  if (-not ($config.Version -is [int]) -or $config.Version -ne 1) { return $false }
  foreach ($propertyName in @("ServerPort", "CodexPort", "ClaudePort")) {
    if (-not (Test-ServicePortValue $config.$propertyName)) { return $false }
  }
  if (-not ($config.BasePath -is [string]) -or
      [string]::IsNullOrWhiteSpace($config.BasePath) -or
      -not $config.BasePath.StartsWith("/")) {
    return $false
  }
  foreach ($propertyName in @("Profile", "DataDir", "AllowedImagePaths")) {
    if (-not (Test-NullableServiceString $config.$propertyName)) { return $false }
  }
  return $true
}

function Assert-ServiceConfigSchema($config, $path) {
  if (-not (Test-ServiceConfigSchema $config)) {
    throw "Invalid production service configuration schema: $path"
  }
}
