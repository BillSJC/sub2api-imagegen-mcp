[CmdletBinding()]
param(
  [Parameter()]
  [string]$BaseUrl = $env:SUB2API_BASE_URL,

  [Parameter()]
  [string]$ApiKeyFile = $env:SUB2API_API_KEY_FILE,

  [Parameter()]
  [string]$InstallDir = $env:SUB2API_MCP_INSTALL_DIR,

  [Parameter()]
  [string]$OutputDir = $env:SUB2API_IMAGE_OUTPUT_DIR,

  [Parameter()]
  [string]$Model = $env:SUB2API_IMAGE_MODEL,

  [Parameter()]
  [string]$TimeoutMs = $env:SUB2API_TIMEOUT_MS,

  [Parameter()]
  [string]$Repository = $env:SUB2API_MCP_REPOSITORY_URL,

  [Parameter()]
  [Alias("Ref")]
  [string]$RepositoryRef = $env:SUB2API_MCP_REF,

  [Parameter()]
  [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverName = "sub2api_imagegen"
$defaultRepository = "https://github.com/BillSJC/sub2api-imagegen-mcp.git"
$minimumNodeVersion = "20.19.0"
$secretTemporaryPath = $null
$configBackup = $null
$configExisted = $false
$configTouched = $false
$configCommitted = $false
$configPath = $null
$configOriginalAcl = $null

function Write-InstallerLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Output "[sub2api-imagegen-mcp] $Message"
}

function Assert-NoControlCharacter {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowEmptyString()][string]$Value
  )
  if ($null -ne $Value -and ($Value.Contains("`r") -or $Value.Contains("`n"))) {
    throw "$Name must not contain line breaks."
  }
}

function ConvertTo-FullyQualifiedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  Assert-NoControlCharacter -Name $Name -Value $Value
  if (-not [System.IO.Path]::IsPathRooted($Value)) {
    throw "$Name must be an absolute path: $Value"
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Assert-NotReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Name must not be a symbolic link or reparse point: $Path"
  }
}

function Test-SourceTree {
  param([Parameter(Mandatory = $true)][string]$Candidate)
  $packagePath = Join-Path $Candidate "package.json"
  if (
    -not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $Candidate "src\index.ts") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $Candidate "scripts\configure-codex.mjs") -PathType Leaf)
  ) {
    return $false
  }
  $packageSource = [System.IO.File]::ReadAllText($packagePath)
  return $packageSource.Contains('"name": "sub2api-imagegen-mcp"')
}

function Get-ExecutablePath {
  param(
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string[]]$Candidates
  )
  foreach ($candidate in $Candidates) {
    $command = Get-Command -Name $candidate -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
      return [System.IO.Path]::GetFullPath($command.Source)
    }
  }
  throw "Required command not found: $DisplayName"
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$DisplayName
  )
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($exitCode -ne 0) {
    throw "$DisplayName failed with exit code $exitCode."
  }
}

function Get-NativeText {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$DisplayName
  )
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  $text = (($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
  if ($exitCode -ne 0) {
    if ([string]::IsNullOrWhiteSpace($text)) {
      throw "$DisplayName failed with exit code $exitCode."
    }
    throw "$DisplayName failed with exit code $exitCode.`n$text"
  }
  return $text
}

function Test-NativeSuccess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $FilePath @ArgumentList *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return $exitCode -eq 0
}

function Get-PrivateFileSystemRule {
  param(
    [Parameter(Mandatory = $true)]
    [System.Security.Principal.SecurityIdentifier]$Identity,
    [Parameter(Mandatory = $true)]
    [bool]$Directory
  )
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($Directory) {
    $inheritance =
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  return [System.Security.AccessControl.FileSystemAccessRule]::new(
    $Identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}

function Assert-PrivateAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]
    [System.Security.Principal.SecurityIdentifier]$Identity
  )
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) {
    throw "Failed to disable inherited permissions on $Path"
  }
  $hasCurrentUser = $false
  $rules = $acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    if ($rule.IdentityReference.Value -ne $Identity.Value) {
      throw "Unexpected account retains access to private path: $Path"
    }
    $hasCurrentUser = $true
  }
  if (-not $hasCurrentUser) {
    throw "Current user does not have access to private path: $Path"
  }
}

function Set-PrivateDirectoryAcl {
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]
    [System.Security.Principal.SecurityIdentifier]$Identity
  )
  if (-not $PSCmdlet.ShouldProcess($Path, "Restrict directory ACL to the current user")) {
    return
  }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    $acl.PurgeAccessRules($rule.IdentityReference)
  }
  $acl.SetAccessRule((Get-PrivateFileSystemRule -Identity $Identity -Directory $true))
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-PrivateAcl -Path $Path -Identity $Identity
}

function Set-PrivateFileAcl {
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]
    [System.Security.Principal.SecurityIdentifier]$Identity
  )
  if (-not $PSCmdlet.ShouldProcess($Path, "Restrict file ACL to the current user")) {
    return
  }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    $acl.PurgeAccessRules($rule.IdentityReference)
  }
  $acl.SetAccessRule((Get-PrivateFileSystemRule -Identity $Identity -Directory $false))
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-PrivateAcl -Path $Path -Identity $Identity
}

function Read-SecretText {
  param([Parameter(Mandatory = $true)][string]$Prompt)
  $secureValue = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Write-SecretFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)]
    [System.Security.Principal.SecurityIdentifier]$Identity
  )
  $directory = Split-Path -Parent $Path
  $temporaryPath = Join-Path $directory (
    ".sub2api-api-key.{0}.{1}.tmp" -f $PID, [Guid]::NewGuid().ToString("N")
  )
  $script:secretTemporaryPath = $temporaryPath
  $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($temporaryPath, "$Value`n", $utf8WithoutBom)
  Set-PrivateFileAcl -Path $temporaryPath -Identity $Identity
  if (Test-Path -LiteralPath $Path) {
    [System.IO.File]::Replace($temporaryPath, $Path, $null)
  } else {
    [System.IO.File]::Move($temporaryPath, $Path)
  }
  $script:secretTemporaryPath = $null
  Set-PrivateFileAcl -Path $Path -Identity $Identity
}

$runningOnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if (-not $runningOnWindows) {
  throw "install.ps1 supports native Windows only. Use install.sh on macOS, Linux, or WSL2."
}
if (
  $PSVersionTable.PSVersion.Major -lt 5 -or
  (
    $PSVersionTable.PSVersion.Major -eq 5 -and
    $PSVersionTable.PSVersion.Minor -lt 1
  )
) {
  throw "Windows PowerShell 5.1 or PowerShell 7 or newer is required."
}
$securityModuleManifest = Join-Path $PSHOME (
  "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
)
if (-not (Test-Path -LiteralPath $securityModuleManifest -PathType Leaf)) {
  throw "The built-in Microsoft.PowerShell.Security module is unavailable."
}
Import-Module -Name $securityModuleManifest -ErrorAction Stop

$trackedEnvironmentNames = @(
  "CODEX_HOME",
  "SUB2API_API_KEY",
  "SUB2API_API_KEY_FILE",
  "SUB2API_BASE_URL",
  "SUB2API_IMAGE_MODEL",
  "SUB2API_IMAGE_OUTPUT_DIR",
  "SUB2API_TIMEOUT_MS"
)
$originalEnvironment = @{}
foreach ($name in $trackedEnvironmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$apiKeyValue = $originalEnvironment["SUB2API_API_KEY"]
Remove-Item Env:SUB2API_API_KEY -ErrorAction SilentlyContinue

try {
  $nonInteractiveMode =
    $NonInteractive.IsPresent -or $env:SUB2API_MCP_NON_INTERACTIVE -eq "1"

  if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = "gpt-image-2"
  }
  if ([string]::IsNullOrWhiteSpace($TimeoutMs)) {
    $TimeoutMs = "600000"
  }
  if ([string]::IsNullOrWhiteSpace($Repository)) {
    $Repository = $defaultRepository
  }
  if ([string]::IsNullOrWhiteSpace($RepositoryRef)) {
    $RepositoryRef = "main"
  }

  Assert-NoControlCharacter -Name "Sub2API base URL" -Value $BaseUrl
  Assert-NoControlCharacter -Name "model" -Value $Model
  Assert-NoControlCharacter -Name "timeout" -Value $TimeoutMs
  Assert-NoControlCharacter -Name "repository" -Value $Repository
  Assert-NoControlCharacter -Name "repository ref" -Value $RepositoryRef

  $parsedTimeout = 0
  if (
    -not [int]::TryParse(
      $TimeoutMs,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsedTimeout
    ) -or
    $parsedTimeout -lt 1000 -or
    $parsedTimeout -gt 900000
  ) {
    throw "Timeout must be an integer between 1000 and 900000 milliseconds."
  }
  $TimeoutMs = $parsedTimeout.ToString([Globalization.CultureInfo]::InvariantCulture)
  $toolTimeoutSec = [int][Math]::Ceiling($parsedTimeout / 1000.0) + 60

  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  $picturesDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::MyPictures
  )
  if (
    [string]::IsNullOrWhiteSpace($userProfile) -or
    [string]::IsNullOrWhiteSpace($localAppData)
  ) {
    throw "Windows user profile directories could not be resolved."
  }
  if ([string]::IsNullOrWhiteSpace($picturesDirectory)) {
    $picturesDirectory = Join-Path $userProfile "Pictures"
  }

  $scriptRoot = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    if (
      -not [string]::IsNullOrWhiteSpace($scriptRoot) -and
      (Test-SourceTree -Candidate $scriptRoot)
    ) {
      $InstallDir = $scriptRoot
    } else {
      $InstallDir = Join-Path $localAppData "sub2api-imagegen-mcp\app"
    }
  }
  if ([string]::IsNullOrWhiteSpace($ApiKeyFile)) {
    $ApiKeyFile = Join-Path $localAppData (
      "sub2api-imagegen-mcp\secrets\sub2api-api.key"
    )
  }
  if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $picturesDirectory "Sub2API"
  }
  $codexHome = $env:CODEX_HOME
  if ([string]::IsNullOrWhiteSpace($codexHome)) {
    $codexHome = Join-Path $userProfile ".codex"
  }

  $InstallDir = ConvertTo-FullyQualifiedPath -Name "Install directory" -Value $InstallDir
  $ApiKeyFile = ConvertTo-FullyQualifiedPath -Name "API key file" -Value $ApiKeyFile
  $OutputDir = ConvertTo-FullyQualifiedPath -Name "Output directory" -Value $OutputDir
  $codexHome = ConvertTo-FullyQualifiedPath -Name "CODEX_HOME" -Value $codexHome

  Assert-NotReparsePoint -Name "Install directory" -Path $InstallDir
  Assert-NotReparsePoint -Name "API key file" -Path $ApiKeyFile

  $nodeCommand = Get-ExecutablePath -DisplayName "node.exe" -Candidates @("node.exe")
  $npmCommand = Get-ExecutablePath -DisplayName "npm.cmd" -Candidates @("npm.cmd")
  $gitCommand = Get-ExecutablePath -DisplayName "git.exe" -Candidates @("git.exe")

  $versionCheck = @'
const current = process.versions.node.split(".").map(Number);
const minimum = process.argv[1].split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  if (current[index] > minimum[index]) process.exit(0);
  if (current[index] < minimum[index]) process.exit(1);
}
'@
  try {
    Invoke-NativeCommand -FilePath $nodeCommand -ArgumentList @(
      "-e",
      $versionCheck,
      $minimumNodeVersion
    ) -DisplayName "Node.js version check"
  } catch {
    $foundVersion = Get-NativeText -FilePath $nodeCommand -ArgumentList @(
      "--version"
    ) -DisplayName "node --version"
    throw "Node.js $minimumNodeVersion or newer is required; found $foundVersion."
  }
  $nodePath = Get-NativeText -FilePath $nodeCommand -ArgumentList @(
    "-p",
    "process.execPath"
  ) -DisplayName "Node.js executable lookup"
  $nodePath = ConvertTo-FullyQualifiedPath -Name "Node executable" -Value $nodePath

  $codexOverride = $env:SUB2API_MCP_CODEX_BIN
  if ([string]::IsNullOrWhiteSpace($codexOverride)) {
    $codexCommand = Get-ExecutablePath -DisplayName "codex.cmd" -Candidates @(
      "codex.exe",
      "codex.cmd"
    )
  } else {
    $codexCommand = ConvertTo-FullyQualifiedPath -Name "Codex executable" -Value $codexOverride
    if (-not (Test-Path -LiteralPath $codexCommand -PathType Leaf)) {
      throw "Codex executable does not exist: $codexCommand"
    }
  }

  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    if ($nonInteractiveMode) {
      throw "Sub2API base URL is required in non-interactive mode."
    }
    $BaseUrl = Read-Host -Prompt (
      "Sub2API base URL (for example https://api.example.com/v1)"
    )
  }
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    throw "Sub2API base URL cannot be empty."
  }
  Assert-NoControlCharacter -Name "Sub2API base URL" -Value $BaseUrl

  if (Test-SourceTree -Candidate $InstallDir) {
    if (
      (Test-Path -LiteralPath (Join-Path $InstallDir ".git") -PathType Container) -and
      $env:SUB2API_MCP_NO_UPDATE -ne "1"
    ) {
      $originUrl = Get-NativeText -FilePath $gitCommand -ArgumentList @(
        "-C",
        $InstallDir,
        "remote",
        "get-url",
        "origin"
      ) -DisplayName "Git origin lookup"
      if ($Repository -eq $defaultRepository) {
        $allowedOrigins = @(
          $defaultRepository,
          "git@github.com:BillSJC/sub2api-imagegen-mcp.git",
          "ssh://git@github.com/BillSJC/sub2api-imagegen-mcp.git"
        )
        if ($allowedOrigins -notcontains $originUrl) {
          throw "Install repository origin is unexpected: $originUrl"
        }
      } elseif ($originUrl -ne $Repository) {
        throw "Install repository origin does not match -Repository."
      }

      $trackedChanges = Get-NativeText -FilePath $gitCommand -ArgumentList @(
        "-C",
        $InstallDir,
        "status",
        "--porcelain",
        "--untracked-files=no"
      ) -DisplayName "Git status"
      if (-not [string]::IsNullOrWhiteSpace($trackedChanges)) {
        throw "Install repository has tracked changes; commit or discard them before updating."
      }
      $currentBranch = Get-NativeText -FilePath $gitCommand -ArgumentList @(
        "-C",
        $InstallDir,
        "branch",
        "--show-current"
      ) -DisplayName "Git branch lookup"
      if ($currentBranch -ne $RepositoryRef) {
        throw "Install repository must be on '$RepositoryRef'; found '$currentBranch'."
      }
      Write-InstallerLog "Updating existing installation from origin/$RepositoryRef..."
      Invoke-NativeCommand -FilePath $gitCommand -ArgumentList @(
        "-C",
        $InstallDir,
        "fetch",
        "--prune",
        "origin",
        $RepositoryRef
      ) -DisplayName "git fetch"
      Invoke-NativeCommand -FilePath $gitCommand -ArgumentList @(
        "-C",
        $InstallDir,
        "merge",
        "--ff-only",
        "origin/$RepositoryRef"
      ) -DisplayName "git merge"
    }
  } else {
    if (
      (Test-Path -LiteralPath $InstallDir) -and
      -not (Test-Path -LiteralPath $InstallDir -PathType Container)
    ) {
      throw "Install path exists and is not a directory: $InstallDir"
    }
    if (
      (Test-Path -LiteralPath $InstallDir -PathType Container) -and
      @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0
    ) {
      throw "Install directory is non-empty and is not this MCP repository: $InstallDir"
    }
    $installParent = Split-Path -Parent $InstallDir
    [System.IO.Directory]::CreateDirectory($installParent) | Out-Null
    Write-InstallerLog "Cloning public repository into $InstallDir..."
    Invoke-NativeCommand -FilePath $gitCommand -ArgumentList @(
      "clone",
      "--branch",
      $RepositoryRef,
      "--single-branch",
      $Repository,
      $InstallDir
    ) -DisplayName "git clone"
    if (-not (Test-SourceTree -Candidate $InstallDir)) {
      throw "Cloned repository is missing expected MCP files."
    }
  }

  $InstallDir = (Get-Item -LiteralPath $InstallDir -Force).FullName
  Write-InstallerLog "Installing locked dependencies and building MCP..."
  Push-Location -LiteralPath $InstallDir
  try {
    Invoke-NativeCommand -FilePath $npmCommand -ArgumentList @(
      "ci"
    ) -DisplayName "npm ci"
    Invoke-NativeCommand -FilePath $npmCommand -ArgumentList @(
      "run",
      "build"
    ) -DisplayName "npm run build"
    if (Test-Path -LiteralPath (Join-Path $InstallDir ".git") -PathType Container) {
      Invoke-NativeCommand -FilePath $npmCommand -ArgumentList @(
        "run",
        "secrets:check"
      ) -DisplayName "npm run secrets:check"
    }
    Invoke-NativeCommand -FilePath $npmCommand -ArgumentList @(
      "prune",
      "--omit=dev"
    ) -DisplayName "npm prune --omit=dev"
  } finally {
    Pop-Location
  }

  $serverEntryPoint = Join-Path $InstallDir "dist\index.js"
  if (-not (Test-Path -LiteralPath $serverEntryPoint -PathType Leaf)) {
    throw "Build did not produce dist\index.js."
  }
  Invoke-NativeCommand -FilePath $nodePath -ArgumentList @(
    $serverEntryPoint,
    "--version"
  ) -DisplayName "MCP version check"

  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentIdentity) {
    throw "Current Windows user SID could not be resolved."
  }

  $keyDirectory = Split-Path -Parent $ApiKeyFile
  [System.IO.Directory]::CreateDirectory($keyDirectory) | Out-Null
  Assert-NotReparsePoint -Name "API key directory" -Path $keyDirectory
  Set-PrivateDirectoryAcl -Path $keyDirectory -Identity $currentIdentity

  if (Test-Path -LiteralPath $ApiKeyFile) {
    $keyItem = Get-Item -LiteralPath $ApiKeyFile -Force
    if ($keyItem.PSIsContainer) {
      throw "API key path must be a regular file: $ApiKeyFile"
    }
  }

  if (-not [string]::IsNullOrEmpty($apiKeyValue)) {
    Assert-NoControlCharacter -Name "SUB2API_API_KEY" -Value $apiKeyValue
    Write-SecretFile -Path $ApiKeyFile -Value $apiKeyValue -Identity $currentIdentity
    $apiKeyValue = $null
  } elseif (
    -not (Test-Path -LiteralPath $ApiKeyFile -PathType Leaf) -or
    (Get-Item -LiteralPath $ApiKeyFile).Length -eq 0
  ) {
    if ($nonInteractiveMode) {
      throw "A non-empty API key file or SUB2API_API_KEY is required in non-interactive mode."
    }
    $apiKeyValue = Read-SecretText -Prompt "Sub2API API Key"
    if ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
      throw "Sub2API API Key cannot be empty."
    }
    Assert-NoControlCharacter -Name "Sub2API API Key" -Value $apiKeyValue
    Write-SecretFile -Path $ApiKeyFile -Value $apiKeyValue -Identity $currentIdentity
    $apiKeyValue = $null
  }
  Set-PrivateFileAcl -Path $ApiKeyFile -Identity $currentIdentity

  [System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null
  Assert-NotReparsePoint -Name "Output directory" -Path $OutputDir
  Set-PrivateDirectoryAcl -Path $OutputDir -Identity $currentIdentity
  $OutputDir = (Get-Item -LiteralPath $OutputDir -Force).FullName
  $ApiKeyFile = (Get-Item -LiteralPath $ApiKeyFile -Force).FullName

  Write-InstallerLog "Validating runtime configuration without making an image request..."
  $env:SUB2API_BASE_URL = $BaseUrl
  $env:SUB2API_API_KEY_FILE = $ApiKeyFile
  $env:SUB2API_IMAGE_OUTPUT_DIR = $OutputDir
  $env:SUB2API_IMAGE_MODEL = $Model
  $env:SUB2API_TIMEOUT_MS = $TimeoutMs
  Remove-Item Env:SUB2API_API_KEY -ErrorAction SilentlyContinue
  Invoke-NativeCommand -FilePath $nodePath -ArgumentList @(
    $serverEntryPoint,
    "--check-config"
  ) -DisplayName "MCP configuration check"

  [System.IO.Directory]::CreateDirectory($codexHome) | Out-Null
  Assert-NotReparsePoint -Name "CODEX_HOME" -Path $codexHome
  $codexHome = (Get-Item -LiteralPath $codexHome -Force).FullName
  $configPath = Join-Path $codexHome "config.toml"
  Assert-NotReparsePoint -Name "Codex config" -Path $configPath
  if (
    (Test-Path -LiteralPath $configPath) -and
    -not (Test-Path -LiteralPath $configPath -PathType Leaf)
  ) {
    throw "Codex config must be a regular file: $configPath"
  }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configExisted = $true
    $configOriginalAcl = Get-Acl -LiteralPath $configPath
    $timestamp = [DateTime]::UtcNow.ToString(
      "yyyyMMddTHHmmssfffZ",
      [Globalization.CultureInfo]::InvariantCulture
    )
    $configBackup = Join-Path $codexHome (
      "config.toml.backup.{0}.{1}" -f $timestamp, $PID
    )
    Copy-Item -LiteralPath $configPath -Destination $configBackup
    Set-PrivateFileAcl -Path $configBackup -Identity $currentIdentity
    Write-InstallerLog "Backed up Codex configuration to $configBackup"
  }

  $env:CODEX_HOME = $codexHome
  $configTouched = $true
  if (
    Test-NativeSuccess -FilePath $codexCommand -ArgumentList @(
      "mcp",
      "get",
      $serverName
    )
  ) {
    Invoke-NativeCommand -FilePath $codexCommand -ArgumentList @(
      "mcp",
      "remove",
      $serverName
    ) -DisplayName "codex mcp remove"
  }
  Invoke-NativeCommand -FilePath $codexCommand -ArgumentList @(
    "mcp",
    "add",
    $serverName,
    "--env",
    "SUB2API_BASE_URL=$BaseUrl",
    "--env",
    "SUB2API_API_KEY_FILE=$ApiKeyFile",
    "--env",
    "SUB2API_IMAGE_OUTPUT_DIR=$OutputDir",
    "--env",
    "SUB2API_IMAGE_MODEL=$Model",
    "--env",
    "SUB2API_TIMEOUT_MS=$TimeoutMs",
    "--",
    $nodePath,
    $serverEntryPoint
  ) -DisplayName "codex mcp add"

  Invoke-NativeCommand -FilePath $nodePath -ArgumentList @(
    (Join-Path $InstallDir "scripts\configure-codex.mjs"),
    "--config",
    $configPath,
    "--cwd",
    $InstallDir,
    "--server",
    $serverName,
    "--tool-timeout-sec",
    $toolTimeoutSec.ToString([Globalization.CultureInfo]::InvariantCulture)
  ) -DisplayName "Codex MCP option configuration"
  Set-PrivateFileAcl -Path $configPath -Identity $currentIdentity

  Invoke-NativeCommand -FilePath $codexCommand -ArgumentList @(
    "mcp",
    "get",
    $serverName,
    "--json"
  ) -DisplayName "Codex MCP verification"
  $configCommitted = $true

  Write-InstallerLog "Installation complete."
  Write-InstallerLog "MCP server: $serverName"
  Write-InstallerLog "Install directory: $InstallDir"
  Write-InstallerLog "API key file: $ApiKeyFile"
  Write-InstallerLog "Image output directory: $OutputDir"
  Write-InstallerLog (
    "Timeouts: Sub2API {0} ms; Codex tool {1} seconds" -f
    $TimeoutMs,
    $toolTimeoutSec
  )
  Write-InstallerLog "Restart ChatGPT/Codex, start a new task, and run /mcp to confirm imagegen."
} catch {
  $failureMessage = $_.Exception.Message
  if ($configTouched -and -not $configCommitted -and $null -ne $configPath) {
    try {
      if ($configExisted -and $null -ne $configBackup) {
        Copy-Item -LiteralPath $configBackup -Destination $configPath -Force
        if ($null -ne $configOriginalAcl) {
          Set-Acl -LiteralPath $configPath -AclObject $configOriginalAcl
        }
        Write-InstallerLog "Restored Codex configuration from $configBackup"
      } elseif (-not $configExisted -and (Test-Path -LiteralPath $configPath)) {
        Remove-Item -LiteralPath $configPath -Force
        Write-InstallerLog "Removed incomplete Codex configuration."
      }
    } catch {
      Write-Warning "Codex configuration rollback failed: $($_.Exception.Message)"
    }
  }
  throw "[sub2api-imagegen-mcp] ERROR: $failureMessage"
} finally {
  $apiKeyValue = $null
  if (
    $null -ne $secretTemporaryPath -and
    (Test-Path -LiteralPath $secretTemporaryPath)
  ) {
    Remove-Item -LiteralPath $secretTemporaryPath -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $trackedEnvironmentNames) {
    $originalValue = $originalEnvironment[$name]
    if ($null -eq $originalValue) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $originalValue, "Process")
    }
  }
}
