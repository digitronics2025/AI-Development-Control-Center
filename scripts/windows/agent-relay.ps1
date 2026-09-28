<#
.SYNOPSIS
  Starts one agent CLI run as the Control Center's agent account (SEC-3,
  docs/systems/security.md "Agent OS boundary").

.DESCRIPTION
  While agent isolation is on (Settings: agentIsolation.mode 'account'), the
  orchestrator starts this script, as the operator, for every stage run. It:

    - reads the launch from the ACC_AGENT_RELAY environment variable (base64
      JSON: account, credentialFile, file, arguments, cwd, restore; nothing
      secret) and removes it;
    - reads the agent account's password from its record, which Windows
      protects for the operator's own user (DPAPI); the password is never
      printed, logged or passed on a command line;
    - starts the program as that account (CreateProcessWithLogonW, through
      .NET) with the run's environment (this process's), its user-folder
      variables pointing at the agent account's own folder;
    - copies this process's stdin (the prompt) to the program, and the
      program's stdout and stderr back byte for byte as they arrive;
    - holds the program in a job object that ends it and everything it
      started when this script ends, however it ends: the orchestrator
      cancels a run by ending this script's process tree;
    - exits with the program's exit code.

  It never runs anything as the operator. When the launch is not possible it
  writes one line starting "Agent isolation:" to stderr and exits 31436
  (AGENT_RELAY_REFUSED_EXIT in packages/agent-sdk/src/run-as.ts).

  -DryRun checks the launch and the password record, creates the job, and
  reports what it would start (as JSON on stdout) without starting anything.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RefusedExit = 31436

function Refuse([string]$message) {
  [Console]::Error.WriteLine("Agent isolation: $message")
  exit $RefusedExit
}

function Get-InnerMessage($errorRecord) {
  $e = $errorRecord.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  return $e.Message
}

# ----- the launch --------------------------------------------------------------------------

$encoded = [Environment]::GetEnvironmentVariable('ACC_AGENT_RELAY')
[Environment]::SetEnvironmentVariable('ACC_AGENT_RELAY', $null)
if (-not $encoded) { Refuse 'no launch was given.' }
try {
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
} catch {
  Refuse 'the launch could not be read.'
}
$account = [string]$spec.account
if ($account -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{2,19}$') { Refuse "'$account' is not an agent account name." }
foreach ($field in 'file', 'cwd', 'credentialFile') {
  if (-not [string]$spec.$field) { Refuse "the launch has no $field." }
}

# ----- the password (the operator's DPAPI record) ----------------------------------------

$recordFile = [string]$spec.credentialFile
if (-not (Test-Path -LiteralPath $recordFile -PathType Leaf)) {
  Refuse "the Windows account $account is not set up on this computer. Set it up with the privileged helper's agent_account_create, or turn agent isolation off in Settings."
}
try {
  $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $password = ConvertTo-SecureString -String ([string]$record.protectedSecret)
} catch {
  Refuse "the password of $account could not be read. Only the Windows user who set the account up can read it: set it up again while signed in as yourself, or turn agent isolation off in Settings."
}
if ([string]$record.account -ne $account) { Refuse "the agent account set up on this computer is '$($record.account)', not '$account'." }

# ----- a job that ends the whole run with this script ------------------------------------

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AccAgentRelayJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  const int JobObjectExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  // Never closed: the job ends, and with it every process in it, when this process ends.
  public static IntPtr CreateKillOnClose() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ExtendedLimits info = new ExtendedLimits();
    info.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
    return job;
  }

  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
  }
}
'@
try {
  $job = [AccAgentRelayJob]::CreateKillOnClose()
} catch {
  Refuse "the run could not be given a job to end it with: $(Get-InnerMessage $_)"
}

if ($DryRun) {
  $stdin = New-Object IO.MemoryStream
  [Console]::OpenStandardInput().CopyTo($stdin)
  $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stdin.ToArray())).Replace('-', '').ToLowerInvariant()
  $names = @([Environment]::GetEnvironmentVariables().Keys | ForEach-Object { [string]$_ } | Sort-Object)
  $plan = [pscustomobject]@{ account = $account; file = [string]$spec.file; arguments = [string]$spec.arguments; cwd = [string]$spec.cwd; environment = $names; stdinBytes = $stdin.Length; stdinSha256 = $sha; job = ($job -ne [IntPtr]::Zero) }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($plan | ConvertTo-Json -Compress))
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
  exit 0
}

# ----- the account ----------------------------------------------------------------------

try {
  $sid = (New-Object Security.Principal.NTAccount([Environment]::MachineName, $account)).Translate([Security.Principal.SecurityIdentifier]).Value
} catch {
  Refuse "there is no Windows account named $account on this computer. Set it up with the privileged helper's agent_account_create, or turn agent isolation off in Settings."
}
if ($sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { Refuse "$account is your own Windows account; agent runs need a separate one." }
$agentHome = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
if (-not $agentHome) { Refuse "$account has never signed in on this computer, so it has no user folder yet. Sign in as it once (runas /user:$account cmd) and sign in to the agent CLIs there." }
$agentHome = [Environment]::ExpandEnvironmentVariables([string]$agentHome)
$agentLocal = Join-Path $agentHome 'AppData\Local'

# ----- start it -------------------------------------------------------------------------

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = [string]$spec.file
$psi.Arguments = [string]$spec.arguments
$psi.WorkingDirectory = [string]$spec.cwd
$psi.UserName = $account
$psi.Domain = [Environment]::MachineName
$psi.Password = $password
$psi.LoadUserProfile = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# The run's environment, as the orchestrator gave it to this script, with the agent account's folders.
$psi.Environment.Clear()
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $psi.Environment[[string]$entry.Key] = [string]$entry.Value }
foreach ($name in 'PSExecutionPolicyPreference', 'PSModulePath') {
  $value = $spec.restore.$name
  if ($null -eq $value) { [void]$psi.Environment.Remove($name) } else { $psi.Environment[$name] = [string]$value }
}
$profileVariables = @{
  USERPROFILE  = $agentHome
  HOME         = $agentHome
  HOMEDRIVE    = $agentHome.Substring(0, 2)
  HOMEPATH     = $agentHome.Substring(2)
  APPDATA      = (Join-Path $agentHome 'AppData\Roaming')
  LOCALAPPDATA = $agentLocal
  TEMP         = (Join-Path $agentLocal 'Temp')
  TMP          = (Join-Path $agentLocal 'Temp')
  USERNAME     = $account
}
foreach ($name in $profileVariables.Keys) { $psi.Environment[$name] = $profileVariables[$name] }

try {
  $process = [Diagnostics.Process]::Start($psi)
} catch {
  Refuse "$($spec.file) could not be started as ${account}: $(Get-InnerMessage $_)"
}
try {
  [AccAgentRelayJob]::Assign($job, $process.Handle)
} catch {
  try { $process.Kill() } catch { }
  Refuse "the run of $account could not be held in its job, so it was stopped: $(Get-InnerMessage $_)"
}
$password = $null

# ----- relay its streams ----------------------------------------------------------------

$stdout = [Console]::OpenStandardOutput()
$stderr = [Console]::OpenStandardError()
$copies = [Threading.Tasks.Task[]]@($process.StandardOutput.BaseStream.CopyToAsync($stdout), $process.StandardError.BaseStream.CopyToAsync($stderr))
try {
  [Console]::OpenStandardInput().CopyTo($process.StandardInput.BaseStream)
} catch {
  # The program may end before it reads its input; its exit code says how it ended.
}
try { $process.StandardInput.Close() } catch { }
$process.WaitForExit()
# Something the program left running may hold its output open: the job ends it when this script exits.
try { [void][Threading.Tasks.Task]::WaitAll($copies, 10000) } catch { }
$stdout.Flush()
$stderr.Flush()
exit $process.ExitCode
