import type { CommandRisk, PermissionLevel } from '@acc/shared';
import { commandWord, decodeEncodedCommands, expandAlias, splitCommands, unwrapInterpreter } from './shell-parse.js';

/**
 * Command classification (PLAN §30, V2 plan §2). Every command the
 * orchestrator runs on someone's behalf — repository commands, agent tool
 * calls, terminal input typed by an agent — is classified before launch.
 *
 * It is shell-aware where practical: the line is split into the commands it
 * runs, nested interpreters (`cmd /c`, `powershell -Command`, `bash -c`,
 * `wsl`) and PowerShell `-EncodedCommand` payloads are unwrapped and judged
 * by their content, and PowerShell aliases are expanded. The result names the
 * permission level the command needs and the kinds of effect it has.
 */

export const COMMAND_EFFECTS = [
  'filesystem',
  'git',
  'network',
  'credentials',
  'privilege',
  'database',
  'infrastructure',
  'production',
  'process',
  'persistence',
  'code-execution',
] as const;
export type CommandEffect = (typeof COMMAND_EFFECTS)[number];

export interface CommandClassification {
  risk: CommandRisk;
  level: PermissionLevel;
  /** Human explanation of why the command landed in this class. */
  reasons: string[];
  production: boolean;
  /** What the command can affect, for audit and policy. */
  effects: CommandEffect[];
  /** Nothing in the command writes, deletes, installs or leaves the machine. */
  readOnly: boolean;
}

interface Pattern {
  test: RegExp;
  risk: CommandRisk;
  level: PermissionLevel;
  reason: string;
  effects: CommandEffect[];
}

const PRODUCTION = /(?:--env(?:ironment)?[ =]+(?:prod|production)\b|\bprod(?:uction)?\b.*\b(?:deploy|migrat|release)|\b(?:deploy|migrat|release)\w*\b.*\bprod(?:uction)?\b|--remote\b.*\bprod)/i;

const REGISTRY_PATH = String.raw`(?:HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+|Registry::)`;
const DOWNLOAD = /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl(?:\.exe)?|wget|Start-BitsTransfer|DownloadString|DownloadFile|DownloadData|Net\.WebClient|bitsadmin)\b/i;
const EXECUTE = /(?:\bInvoke-Expression\b|\biex\b|\|\s*(?:ba|z|da)?sh\b|\|\s*(?:pwsh|powershell)\b|\|\s*python\d?\b|\|\s*node\b|\[scriptblock\]::Create|\bStart-Process\b|&\s*\(\s*\[scriptblock\])/i;

/** Rules applied to each command segment (original text and alias-expanded text). */
const PATTERNS: Pattern[] = [
  // ---- Destructive file-system operations ------------------------------------------------
  { test: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)/i, risk: 'dangerous', level: 5, reason: 'Recursive deletion', effects: ['filesystem'] },
  { test: /^(?:rmdir|rd)\s+(?:\/[a-z]\s+)*\/s\b/i, risk: 'dangerous', level: 5, reason: 'Recursive directory deletion', effects: ['filesystem'] },
  { test: /^(?:del|erase)\s+(?:\/[a-z]\s+)*\/s\b/i, risk: 'dangerous', level: 5, reason: 'Recursive file deletion', effects: ['filesystem'] },
  { test: /\bRemove-Item\b.*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/i, risk: 'dangerous', level: 5, reason: 'Recursive deletion', effects: ['filesystem'] },
  { test: /^(?:format(?:\.com)?\s+[a-z]:|mkfs(?:\.\w+)?\s|diskpart\b)|\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i, risk: 'dangerous', level: 5, reason: 'Disk formatting', effects: ['filesystem'] },
  { test: /\bcipher(?:\.exe)?\s+\/w\b|\bvssadmin(?:\.exe)?\s+delete\b|\bwbadmin\s+delete\b/i, risk: 'dangerous', level: 5, reason: 'Destroys backups or free-space data', effects: ['filesystem'] },
  { test: /\bdd\s+.*\bof=\/dev\//i, risk: 'dangerous', level: 5, reason: 'Writes directly to a device', effects: ['filesystem'] },
  { test: /\bchmod\s+(?:-R\s+)?[0-7]*777\s+\/(?:\s|$)|\bchown\s+-R\s+\S+\s+\/(?:\s|$)/i, risk: 'dangerous', level: 5, reason: 'Changes ownership or permissions of the whole system', effects: ['filesystem', 'privilege'] },
  // ---- Git history --------------------------------------------------------------------------
  { test: /\bgit\s+clean\s+-[a-z]*f/i, risk: 'dangerous', level: 5, reason: 'Deletes untracked files', effects: ['git', 'filesystem'] },
  { test: /\bgit\s+reset\s+--hard\b/i, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work', effects: ['git', 'filesystem'] },
  { test: /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)|\bgit\s+restore\s+(?:--\S+\s+)*\.(?:\s|$)/i, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work', effects: ['git', 'filesystem'] },
  { test: /\bgit\s+push\b.*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S+)/i, risk: 'dangerous', level: 5, reason: 'Force push rewrites remote history', effects: ['git', 'network'] },
  { test: /\bgit\s+push\b.*\s--delete\b|\bgit\s+push\s+\S+\s+:\S+/i, risk: 'dangerous', level: 5, reason: 'Deletes a remote branch', effects: ['git', 'network'] },
  { test: /\bgit\s+(?:filter-branch|filter-repo)\b|\bgit\s+rebase\b|\bgit\s+commit\b.*--amend\b/i, risk: 'dangerous', level: 5, reason: 'Rewrites Git history', effects: ['git'] },
  { test: /\bgit\s+branch\s+(?:\S+\s+)*-D\b|\bgit\s+stash\s+(?:drop|clear)\b|\bgit\s+update-ref\s+-d\b/i, risk: 'dangerous', level: 5, reason: 'Deletes Git data that may not be recoverable', effects: ['git'] },
  // ---- Databases ----------------------------------------------------------------------------
  { test: /\bdrop\s+(?:table|database|schema|index|view)\b/i, risk: 'dangerous', level: 5, reason: 'Drops database objects', effects: ['database'] },
  { test: /\btruncate\s+(?:table\s+)?\w+/i, risk: 'dangerous', level: 5, reason: 'Truncates a table', effects: ['database'] },
  { test: /\bdelete\s+from\s+\w+(?![^;]*\bwhere\b)/i, risk: 'dangerous', level: 5, reason: 'Deletes every row of a table', effects: ['database'] },
  // ---- Infrastructure -----------------------------------------------------------------------
  { test: /\bterraform\s+destroy\b/i, risk: 'dangerous', level: 5, reason: 'Destroys infrastructure', effects: ['infrastructure'] },
  { test: /\bkubectl\s+delete\b/i, risk: 'dangerous', level: 5, reason: 'Deletes cluster resources', effects: ['infrastructure'] },
  { test: /\bwrangler\s+(?:\S+\s+)*(?:delete|destroy)\b/i, risk: 'dangerous', level: 5, reason: 'Deletes Cloudflare resources', effects: ['infrastructure'] },
  { test: /\b(?:npm|pnpm|yarn)\s+unpublish\b/i, risk: 'dangerous', level: 5, reason: 'Removes a published package', effects: ['network'] },
  // ---- Machine: privilege, security, persistence -----------------------------------------------
  { test: /\bStart-Process\b.*-Verb\s+["']?RunAs\b|^(?:sudo|gsudo|runas|doas|psexec(?:64)?)\b/i, risk: 'dangerous', level: 5, reason: 'Runs with elevated privileges', effects: ['privilege'] },
  { test: /\b(?:Set|Add)-MpPreference\b.*-(?:Exclusion\w*|Disable\w+)|\bUninstall-WindowsFeature\s+Windows-Defender/i, risk: 'dangerous', level: 5, reason: 'Weakens Windows Defender', effects: ['privilege', 'persistence'] },
  { test: /\b(?:Stop-Computer|Restart-Computer)\b|^shutdown(?:\.exe)?\s+[/-][rsph]\b|\bbcdedit\b|\bwevtutil(?:\.exe)?\s+cl\b|\bClear-EventLog\b/i, risk: 'dangerous', level: 5, reason: 'Shuts down, reconfigures boot or erases system logs', effects: ['persistence'] },
  { test: /\b(?:Remove-Service|sc(?:\.exe)?\s+delete)\b/i, risk: 'dangerous', level: 5, reason: 'Deletes a Windows service', effects: ['persistence', 'process'] },
  { test: new RegExp(String.raw`\b(?:Remove-Item|Remove-ItemProperty|reg(?:\.exe)?\s+delete)\b.*${REGISTRY_PATH}|^reg(?:\.exe)?\s+delete\b`, 'i'), risk: 'dangerous', level: 5, reason: 'Deletes registry data', effects: ['persistence'] },
  { test: new RegExp(String.raw`\b(?:Set-ItemProperty|New-ItemProperty|New-Item|Set-Item|Rename-ItemProperty)\b.*${REGISTRY_PATH}|^reg(?:\.exe)?\s+(?:add|import|copy|restore|load)\b`, 'i'), risk: 'elevated', level: 4, reason: 'Changes the Windows registry', effects: ['persistence'] },
  { test: /\bSet-ExecutionPolicy\b/i, risk: 'elevated', level: 4, reason: 'Changes the PowerShell execution policy', effects: ['persistence', 'privilege'] },
  { test: /\b(?:Register|Unregister|Set|New|Enable)-ScheduledTask\b|^schtasks(?:\.exe)?\s+\/(?:create|change|delete|run)\b|^crontab\s+(?!-l)|\bsystemctl\s+(?:enable|disable|mask)\b|\blaunchctl\s+(?:load|bootstrap)\b/i, risk: 'elevated', level: 4, reason: 'Adds or changes a scheduled or startup job', effects: ['persistence'] },
  { test: /\b(?:New|Set|Start|Stop|Restart|Suspend|Resume)-Service\b|^sc(?:\.exe)?\s+(?:create|config|start|stop|failure|pause)\b|^net(?:\.exe)?\s+(?:start|stop)\s+\S|\bsystemctl\s+(?:start|stop|restart)\b/i, risk: 'elevated', level: 4, reason: 'Starts, stops or changes a system service', effects: ['process', 'persistence'] },
  { test: /\bnetsh(?:\.exe)?\s+(?:advfirewall|firewall|interface|wlan)\b|\b(?:New|Set|Remove|Enable|Disable)-NetFirewall\w*\b|\b(?:New|Set|Remove)-NetIPAddress\b|\bufw\s+(?:allow|deny|delete|disable)\b|\biptables\b/i, risk: 'elevated', level: 4, reason: 'Changes firewall or network configuration', effects: ['infrastructure', 'network'] },
  { test: /^(?:winget|choco|scoop|apt(?:-get)?|yum|dnf|brew|pacman|snap)\s+(?:install|upgrade|uninstall|remove)\b|\bInstall-(?:Module|Package|Script)\b|\bmsiexec(?:\.exe)?\b/i, risk: 'elevated', level: 4, reason: 'Installs or removes system software', effects: ['persistence', 'network'] },
  { test: /\b(?:npm|pnpm)\s+(?:install|i|add|remove|uninstall)\s+(?:\S+\s+)*(?:-g|--global)\b|\byarn\s+global\s+add\b|\bpip3?\s+install\s+(?:\S+\s+)*--user\b/i, risk: 'elevated', level: 3, reason: 'Installs software for the whole user account', effects: ['persistence', 'network'] },
  { test: /\bgit\s+config\s+(?:--global|--system)\b(?!\s+--(?:get|list|l)\b)/i, risk: 'elevated', level: 3, reason: 'Changes Git configuration outside the repository', effects: ['persistence', 'git'] },
  // ---- Credentials ----------------------------------------------------------------------------
  { test: /\bcmdkey(?:\.exe)?\s+\/list\b|\bvaultcmd\b|\bGet-StoredCredential\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bmimikatz\b|\b(?:cat|type|Get-Content|gc|less|more|head|tail)\b[^|;]*(?:\.ssh[\\/]id_|\.aws[\\/]credentials|\.git-credentials|\.docker[\\/]config\.json|\/etc\/shadow|\.npmrc|\.netrc|\.pgpass)/i, risk: 'elevated', level: 4, reason: 'Reads stored credentials', effects: ['credentials'] },
  // ---- Code execution and process control ------------------------------------------------------
  { test: /\bInvoke-Expression\b|\[scriptblock\]::Create\b|\bAdd-Type\b.*-TypeDefinition\b/i, risk: 'elevated', level: 4, reason: 'Runs dynamically built code', effects: ['code-execution'] },
  { test: /\bInvoke-Command\b.*-(?:ComputerName|Session|HostName)\b|\bEnter-PSSession\b|\bNew-PSSession\b/i, risk: 'elevated', level: 4, reason: 'Runs commands on another machine', effects: ['network', 'code-execution'] },
  { test: /\bStop-Process\b.*-(?:Name|ProcessName)\b|^taskkill(?:\.exe)?\b.*\/im\b|^(?:pkill|killall)\b/i, risk: 'elevated', level: 4, reason: 'Stops processes by name, which can hit unrelated programs', effects: ['process'] },
  // ---- Elevated: leaves the machine -----------------------------------------------------------
  { test: /\bgit\s+push\b/i, risk: 'elevated', level: 3, reason: 'Pushes to a remote', effects: ['git', 'network'] },
  { test: /\bgh\s+(?:pr|release|issue)\s+(?:create|merge|close|edit|delete|comment)\b|\bgh\s+repo\s+(?:create|delete|edit)\b|\bgh\s+api\b.*-X\s*(?:POST|PUT|PATCH|DELETE)\b/i, risk: 'elevated', level: 3, reason: 'Changes GitHub state', effects: ['network'] },
  { test: /\b(?:npm|pnpm|yarn)\s+publish\b/i, risk: 'elevated', level: 4, reason: 'Publishes a package', effects: ['network'] },
  { test: /\bwrangler\s+(?:deploy|publish|pages\s+deploy|versions\s+deploy|rollback|secret\s+put|kv\s+(?:key\s+)?put|r2\s+object\s+put|queues\s+create)\b/i, risk: 'elevated', level: 4, reason: 'Changes Cloudflare resources', effects: ['infrastructure', 'network'] },
  { test: /\bwrangler\s+d1\s+(?:migrations\s+apply|execute)\b.*--remote\b/i, risk: 'elevated', level: 4, reason: 'Changes a remote D1 database', effects: ['database', 'infrastructure'] },
  { test: /\b(?:vercel|netlify|flyctl|fly)\s+deploy\b|\bvercel\b.*--prod\b/i, risk: 'elevated', level: 4, reason: 'Deploys a site', effects: ['infrastructure', 'network'] },
  { test: /\b(?:kubectl\s+apply|helm\s+(?:install|upgrade)|terraform\s+apply)\b/i, risk: 'elevated', level: 4, reason: 'Changes infrastructure', effects: ['infrastructure'] },
  { test: /\b(?:prisma|drizzle-kit|knex|sequelize)\b.*\b(?:migrate\s+deploy|push|migrate)\b/i, risk: 'elevated', level: 4, reason: 'Applies database migrations', effects: ['database'] },
  { test: /\bdocker\s+(?:push|login)\b|\bdocker\s+(?:system|volume|image|container)\s+prune\b/i, risk: 'elevated', level: 4, reason: 'Pushes images or prunes Docker data', effects: ['infrastructure'] },
  { test: /\badb\s+(?:-s\s+\S+\s+)?(?:shell\s+(?:rm|pm\s+clear|pm\s+uninstall)|uninstall|reboot|root|remount)\b/i, risk: 'elevated', level: 4, reason: 'Changes or wipes data on a connected Android device', effects: ['filesystem'] },
];

/** Effects of ordinary commands, recorded for audit; they do not raise the level. */
const EFFECT_HINTS: Array<{ test: RegExp; effects: CommandEffect[] }> = [
  { test: /\bgit\s/i, effects: ['git'] },
  { test: /\b(?:Invoke-WebRequest|Invoke-RestMethod|curl|wget|fetch|git\s+(?:clone|fetch|pull)|(?:npm|pnpm|yarn)\s+(?:install|i|add|ci)|pip3?\s+install|Test-NetConnection|Resolve-DnsName|nslookup|ping)\b/i, effects: ['network'] },
  { test: /\b(?:psql|mysql|sqlite3|mongosh|redis-cli|wrangler\s+d1)\b/i, effects: ['database'] },
  { test: /\b(?:terraform|kubectl|helm|wrangler|aws|gcloud|az|docker)\b/i, effects: ['infrastructure'] },
  { test: /\b(?:Stop-Process|taskkill|kill|Start-Process|Start-Job)\b/i, effects: ['process'] },
  { test: /(?:^|[^<>2&])>{1,2}(?!&)|\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|touch|mv|cp|rm)\b/i, effects: ['filesystem'] },
];

/** Commands that only read. A command made only of these (and no redirection) is Level 1. */
const READ_ONLY_WORDS = new Set([
  'ls', 'dir', 'get-childitem', 'gci', 'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'wc', 'grep', 'rg', 'findstr', 'select-string', 'sls',
  'where', 'where.exe', 'which', 'get-command', 'gcm', 'echo', 'write-output', 'write-host', 'pwd', 'get-location', 'gl', 'test-path', 'resolve-path',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'get-process', 'gps', 'ps', 'get-service', 'gsv', 'get-nettcpconnection', 'get-netudpendpoint', 'netstat',
  'get-ciminstance', 'get-wmiobject', 'hostname', 'whoami', 'systeminfo', 'ipconfig', 'get-netipaddress', 'resolve-dnsname', 'nslookup', 'test-netconnection',
  'ping', 'tasklist', 'get-date', 'date', 'uname', 'printenv', 'get-childitem', 'tree', 'measure-object', 'sort-object', 'select-object', 'where-object',
  'format-table', 'format-list', 'convertto-json', 'convertfrom-json', 'out-string', 'get-filehash', 'du', 'df', 'stat', 'file', 'uptime', 'free', 'top',
]);
const READ_ONLY_GIT = /^git\s+(?:status|diff|log|show|rev-parse|ls-files|ls-tree|blame|describe|shortlog|cat-file|remote(?:\s+-v|\s+show\s+\S+)?|branch(?:\s+(?:-a|-r|-v|-vv|--list|--show-current|--contains\s+\S+))*|tag(?:\s+(?:-l|--list))?|config\s+--(?:get|list|l)\b|reflog(?:\s+show)?|worktree\s+list|stash\s+list)(?:\s|$)/i;
const READ_ONLY_TOOL = /^(?:node|npm|pnpm|yarn|npx|python|python3|py|pip|pip3|uv|java|javac|gradle|adb|docker|wrangler|gh|code|dotnet|go|cargo|rustc|git|pwsh|powershell)(?:\.exe)?\s+(?:--version|-v|-V|version|help|--help)\s*$|^(?:npm|pnpm)\s+(?:ls|list|why|outdated|view|info|config\s+get|root|bin)\b|^pip3?\s+(?:list|show|freeze)\b|^gh\s+(?:auth\s+status|pr\s+(?:list|view|status|diff|checks)|issue\s+(?:list|view)|repo\s+view|run\s+(?:list|view))\b|^adb\s+(?:devices|logcat\s+-d)\b|^docker\s+(?:ps|images|inspect|logs|version|info)\b|^wrangler\s+(?:whoami|deployments\s+list|d1\s+list|tail)\b/i;

function segmentReadOnly(segment: string): boolean {
  if (/(?:^|[^<>2&=])>{1,2}(?!&)/.test(segment)) return false;
  // Method calls on objects (`(Get-WmiObject …).Terminate()`) and command substitution can do anything.
  if (/\)\s*\.\s*\w+\s*\(|\$\(|`[^`]+`|\bInvoke-/i.test(segment)) return false;
  if (READ_ONLY_GIT.test(segment) || READ_ONLY_TOOL.test(segment)) return true;
  return READ_ONLY_WORDS.has(commandWord(segment));
}

const RANK = { normal: 0, elevated: 1, dangerous: 2 } as const;

interface Accumulator {
  risk: CommandRisk;
  level: PermissionLevel;
  reasons: string[];
  effects: Set<CommandEffect>;
  readOnly: boolean;
}

function note(acc: Accumulator, risk: CommandRisk, level: PermissionLevel, reason: string, effects: readonly CommandEffect[]) {
  if (RANK[risk] > RANK[acc.risk]) acc.risk = risk;
  if (level > acc.level) acc.level = level;
  if (!acc.reasons.includes(reason)) acc.reasons.push(reason);
  for (const e of effects) acc.effects.add(e);
}

function analyse(text: string, acc: Accumulator, depth: number): void {
  if (depth > 4) {
    note(acc, 'elevated', 4, 'Deeply nested shells', ['code-execution']);
    return;
  }
  // Encoded PowerShell is judged by what it decodes to.
  for (const decoded of decodeEncodedCommands(text)) {
    note(acc, 'elevated', 4, 'Runs an encoded PowerShell command', ['code-execution']);
    acc.readOnly = false;
    analyse(decoded, acc, depth + 1);
  }
  // Download-and-execute spans pipeline segments, so it is checked on the whole text.
  if (DOWNLOAD.test(text) && EXECUTE.test(text)) note(acc, 'dangerous', 5, 'Downloads and runs code', ['network', 'code-execution']);

  for (const segment of splitCommands(text)) {
    const inner = unwrapInterpreter(segment.text);
    if (inner !== null) {
      analyse(inner, acc, depth + 1);
      continue;
    }
    const variants = [segment.text];
    const expanded = expandAlias(segment.text);
    if (expanded && expanded !== segment.text) variants.push(expanded);
    for (const variant of variants) {
      for (const pattern of PATTERNS) if (pattern.test.test(variant)) note(acc, pattern.risk, pattern.level, pattern.reason, pattern.effects);
      for (const hint of EFFECT_HINTS) if (hint.test.test(variant)) for (const e of hint.effects) acc.effects.add(e);
    }
    if (!segmentReadOnly(segment.text)) acc.readOnly = false;
  }
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = command.replace(/[ \t]+/g, ' ').trim();
  const acc: Accumulator = { risk: 'normal', level: 2, reasons: [], effects: new Set(), readOnly: normalized.length > 0 };
  analyse(normalized, acc, 0);

  const production = PRODUCTION.test(normalized);
  if (production) {
    acc.level = 5;
    if (acc.risk === 'normal') acc.risk = 'elevated';
    acc.reasons.push('Targets production');
    acc.effects.add('production');
    acc.readOnly = false;
  }
  const readOnly = acc.readOnly && acc.risk === 'normal' && acc.level === 2;
  if (readOnly) {
    acc.level = 1;
    acc.reasons.push('Read-only command');
  }
  if (acc.reasons.length === 0) acc.reasons.push('Local command');
  return { risk: acc.risk, level: acc.level, reasons: acc.reasons, production, effects: [...acc.effects], readOnly };
}

/** True when the command needs a human decision regardless of auto-approve settings. */
export function alwaysRequiresApproval(classification: Pick<CommandClassification, 'risk' | 'level'>): boolean {
  return classification.risk === 'dangerous' || classification.level === 5;
}
