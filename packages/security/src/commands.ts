import path from 'node:path';
import type { CommandRisk, PermissionLevel } from '@acc/shared';
import { sensitiveFileReason } from './sensitive-files.js';
import { commandWord, decodeBase64Pipes, decodeEncodedCommands, expandAlias, quoteWord, shellWords, splitCommands, unquote, unwrapInterpreter, type Segment } from './shell-parse.js';

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
// A POSIX shell also runs what it is handed through `eval`, a process substitution (`source <(…)`,
// `bash <(…)`) or `sh -c "$(…)"`.
const EXECUTE = /(?:\bInvoke-Expression\b|\biex\b|\|\s*(?:ba|z|da)?sh\b|\|\s*(?:pwsh|powershell)\b|\|\s*python\d?\b|\|\s*node\b|\[scriptblock\]::Create|\bStart-Process\b|&\s*\(\s*\[scriptblock\])|\beval\s|\b(?:source|(?:ba|z|da|k)?sh)\s+<\(|(?:^|[\s;&|(])\.\s+<\(|\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(/i;
/** Base64 decoded on the spot (`base64 -d`, `certutil -decode`, `[Convert]::FromBase64String`)… */
const DECODE = /\bbase64\s+(?:-d|-D|--decode)\b|\bcertutil(?:\.exe)?\s+-decode\b|\[(?:System\.)?Convert\]::FromBase64String\b/i;
/** …and handed to something that runs it. */
const RUNS_INPUT = /\|\s*(?:(?:ba|z|da|k)?sh|pwsh|powershell|python\d?|node|perl|ruby|iex|Invoke-Expression)\b|\beval\s|\bInvoke-Expression\b|\biex\b/i;

/** An expiry that keeps what recovers a lost commit: `never`, or weeks or more (`2.weeks.ago`, Git's default). */
const KEEPS_HISTORY = String.raw`["']?(?:never|false|\d+[. ](?:weeks?|months?|years?)[. ]ago)["']?(?=\s|$)`;
/**
 * The rest of one Git command: up to the segment's next `git`, so a scan
 * started at each of many `git` words stays linear (a segment may be 100 KB).
 */
const REST_OF_GIT_COMMAND = String.raw`(?:(?!\bgit\b)[^;&|])*`;
/**
 * Quiet data loss (SEC-1): the reflog and unreachable objects are what
 * recovers a lost commit. `gc --prune=` sooner than weeks, `reflog
 * expire|delete`, `git prune` (not a dry run); the same through config is
 * `DATA_LOSS_CONFIG`.
 */
const QUIET_DATA_LOSS = new RegExp(
  String.raw`\bgit\s+gc\b${REST_OF_GIT_COMMAND}\s--prune=(?!${KEEPS_HISTORY})` +
    String.raw`|\bgit\s+reflog\s+(?:expire|delete)\b` +
    String.raw`|\bgit\s+prune\b(?!-)(?!${REST_OF_GIT_COMMAND}\s(?:-n|--dry-run)(?:\s|$))`,
  'i',
);
/**
 * Config for one command that loses history (`git -c gc.pruneExpire=now gc`,
 * `-c gc.reflogExpire=…`, `-c core.logAllRefUpdates=false`), read from Git's
 * global options by `gitCall`, never by a regex over the whole segment.
 */
const DATA_LOSS_CONFIG = new RegExp(
  String.raw`^gc\.(?:[^=\s]*\.)?(?:pruneExpire|reflogExpire|reflogExpireUnreachable)=(?!${KEEPS_HISTORY})|^core\.logAllRefUpdates=(?:false|no|off|0)$`,
  'i',
);

/** Rules applied to each command segment (original, alias-expanded, and without Git's global options). */
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
  // `git clean` with a force flag anywhere (`-fd`, `-d -f`, `--force`) deletes untracked files (audit F-13).
  { test: /\bgit\s+clean\b(?=[^;&|]*\s(?:-[a-z]*f[a-z]*|--force)(?:\s|$))/i, risk: 'dangerous', level: 5, reason: 'Deletes untracked files', effects: ['git', 'filesystem'] },
  { test: /\bgit\s+reset\s+--hard\b/i, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work', effects: ['git', 'filesystem'] },
  // The whole tree however it is written — `.`, `"."`, `'.'`, `./`, `:/`, after `--`, options or a tree-ish
  // (`git checkout HEAD -- .`, `git restore -s HEAD .`) — but not `git restore --staged` alone, which only unstages
  // (review, 2026-09-28). Case-sensitive, as Git is: `-S` is --staged, `-s` a source. Each run of words stops at the
  // next `git`, so a long line is read once, not once per `git` in it.
  { test: /\b[Gg][Ii][Tt]\s+(?:checkout|restore(?!(?=(?:\s+(?![Gg][Ii][Tt]\b)[^\s;&|]+)*?\s+(?:--staged|-S)(?=\s|$))(?!(?:\s+(?![Gg][Ii][Tt]\b)[^\s;&|]+)*?\s+(?:--worktree|-W)(?=\s|$))))(?:\s+(?![Gg][Ii][Tt]\b)[^\s;&|]+)*?\s+["']?(?:\.[\\/]?|:[\\/])["']?(?=\s|$|[;&|)])|\b[Gg][Ii][Tt]\s+(?:checkout|switch)(?:\s+(?![Gg][Ii][Tt]\b)[^\s;&|]+)*?\s+(?:-f|--force|--discard-changes)(?=\s|$)/, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work', effects: ['git', 'filesystem'] },
  { test: /\bgit\s+push\b.*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S+)/i, risk: 'dangerous', level: 5, reason: 'Force push rewrites remote history', effects: ['git', 'network'] },
  { test: /\bgit\s+push\b.*\s(?:--delete|-d|--mirror|--prune)\b|\bgit\s+push\s+\S+\s+:\S+/i, risk: 'dangerous', level: 5, reason: 'Deletes remote branches', effects: ['git', 'network'] },
  { test: /\bgit\s+(?:filter-branch|filter-repo)\b|\bgit\s+rebase\b|\bgit\s+commit\b.*--amend\b/i, risk: 'dangerous', level: 5, reason: 'Rewrites Git history', effects: ['git'] },
  {
    // `-D`, `--delete --force`, `-d -f`, `-df` (audit F-13); a stash drop/clear; a deleted ref; a worktree removed with its changes.
    test: /\bgit\s+branch\b[^;&|]*\s(?:-[a-z]*D[a-z]*|-[a-z]*d[a-z]*f[a-z]*|-[a-z]*f[a-z]*d[a-z]*)(?:\s|$)|\bgit\s+branch\b(?=[^;&|]*\s(?:-d|--delete)(?:\s|$))(?=[^;&|]*\s(?:-f|--force)(?:\s|$))|\bgit\s+stash\s+(?:drop|clear)\b|\bgit\s+update-ref\s+-d\b|\bgit\s+worktree\s+remove\b[^;&|]*\s(?:-f|--force)(?:\s|$)/,
    risk: 'dangerous',
    level: 5,
    reason: 'Deletes Git data that may not be recoverable',
    effects: ['git'],
  },
  { test: QUIET_DATA_LOSS, risk: 'dangerous', level: 5, reason: 'Deletes Git data that may not be recoverable', effects: ['git'] },
  { test: /\bgit\s+restore\b(?![^;&|]*\s(?:--staged|-S)(?:\s|$))|\bgit\s+restore\b(?=[^;&|]*\s(?:--worktree|-W)(?:\s|$))|\bgit\s+checkout\s+(?:\S+\s+)?--\s+\S/i, risk: 'elevated', level: 3, reason: 'Discards uncommitted changes to files', effects: ['git', 'filesystem'] },
  { test: /\b(?:rimraf|del-cli)\b|\bshutil\.rmtree\b|\brmSync\s*\([^)]*recursive|\bfs(?:\.promises)?\.rm\s*\([^)]*recursive/i, risk: 'dangerous', level: 5, reason: 'Recursive deletion', effects: ['filesystem'] },
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
  // POSIX: `eval "$(…)"`, and a script read from a process substitution (`source <(…)`, `bash <(…)`).
  { test: /^(?:builtin\s+)?eval\s|^(?:source|\.|(?:ba|z|da|k)?sh)\s+<\(/i, risk: 'elevated', level: 4, reason: 'Runs dynamically built code', effects: ['code-execution'] },
  { test: /\bInvoke-Command\b.*-(?:ComputerName|Session|HostName)\b|\bEnter-PSSession\b|\bNew-PSSession\b/i, risk: 'elevated', level: 4, reason: 'Runs commands on another machine', effects: ['network', 'code-execution'] },
  { test: /\bStop-Process\b.*-(?:Name|ProcessName)\b|^taskkill(?:\.exe)?\b.*\/im\b|^(?:pkill|killall)\b/i, risk: 'elevated', level: 4, reason: 'Stops processes by name, which can hit unrelated programs', effects: ['process'] },
  // ---- Elevated: leaves the machine -----------------------------------------------------------
  { test: /\bgit\s+push\b/i, risk: 'elevated', level: 3, reason: 'Pushes to a remote', effects: ['git', 'network'] },
  { test: /\bgh\s+(?:secret|variable)\s+(?:set|delete|remove)\b/i, risk: 'elevated', level: 4, reason: 'Changes CI secrets or variables on GitHub', effects: ['credentials', 'network'] },
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
// Subcommands that only read take any arguments; the listing forms of commands that can also
// write (branch, tag, remote, config, reflog, worktree, stash) must be the whole segment (audit F-13).
const READ_ONLY_GIT =
  /^git\s+(?:(?:status|diff|log|show|rev-parse|ls-files|ls-tree|blame|describe|shortlog|cat-file)(?:\s|$)|(?:branch(?:\s+(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains\s+\S+|--merged(?:\s+\S+)?|--no-merged(?:\s+\S+)?))*|tag(?:\s+(?:-l|--list)(?:\s+\S+)?)?|remote(?:\s+-v|\s+show\s+\S+|\s+get-url\s+\S+)?|config\s+(?:--get|--get-all|--list|-l)(?:\s+\S+)?|reflog(?:\s+show(?:\s+\S+)?)?|worktree\s+list|stash\s+list)\s*$)/i;
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

/**
 * The Control Center's own secrets and API (audit F-02): its data folder, the
 * files that hold its token and keys, and its listen address. A command that
 * names one of them is Level 5 — agents are refused, a person must confirm — so
 * an agent running as the operator cannot read the token and drive the API.
 */
/** The key files' bare names: common words in other servers' paths too (`/octokit/auth-token.js`). */
const KEY_FILE_WORDS: readonly RegExp[] = [/\bauth-token\b/i, /\bprivileged-key\b/i, /\bcredential-key(?:\.dpapi)?\b/i];
const SELF_DEFAULTS = [
  /AIDevControlCenter/i,
  /[\\/]ai-control-center[\\/]/i,
  ...KEY_FILE_WORDS,
  /\b(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):4317\b/i,
];
const DEFAULT_PORT = 4317;
let selfReferences: RegExp[] = [...SELF_DEFAULTS];
let selfPorts: ReadonlySet<number> = new Set([DEFAULT_PORT]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Teach the classifier this orchestrator's actual data folder and port (set once at start). */
export function setSelfReferences(self: { dataDir?: string | null; port?: number | null }): void {
  const extra: RegExp[] = [];
  if (self.dataDir) {
    const parts = self.dataDir.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escapeRegExp);
    if (parts.length > 1) extra.push(new RegExp(parts.join('[\\\\/]+'), 'i'));
  }
  const port = self.port && Number.isInteger(self.port) ? self.port : null;
  if (port) extra.push(new RegExp(`\\b(?:127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0):${port}\\b`, 'i'));
  selfReferences = [...SELF_DEFAULTS, ...extra];
  selfPorts = new Set([DEFAULT_PORT, ...(port ? [port] : [])]);
}

/**
 * A hostname, as Node's URL parser normalises it, that reaches this machine:
 * all of 127/8 (`127.1`, `2130706433`, `0x7f000001` and `0177.0.0.1`
 * normalise to it), 0.0.0.0, `localhost` and `*.localhost`, `::1`, `::`, and
 * the IPv4-mapped forms (`[::ffff:127.0.0.1]` normalises to `[::ffff:7f00:1]`).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '0.0.0.0') return true;
  if (h === '::1' || h === '::' || h === '::ffff:0:0') return true;
  // IPv4-mapped and IPv4-compatible 127/8, normalised (`::ffff:7f00:1`) or written out (`::ffff:127.0.0.1`).
  return /^::(?:ffff:)?(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/.test(h);
}

/**
 * A URL (any scheme with an authority, `\` as `/` as Node reads it) inside
 * free text. It starts only where a run of scheme characters starts, and the
 * scheme is bounded, so the scan is linear: an unbounded scheme tried from
 * every word boundary backtracks over a long `a.a.a.…` run, quadratic in its
 * length, and this runs on every agent tool input (up to megabytes).
 */
const URL_IN_TEXT = /(?<![a-z\d+.-])[a-z][a-z\d+.-]{0,31}:[\\/]{2}[^\s"'<>`]+/gi;
/**
 * A host and port without a scheme (`curl 127.1:4317`): a bracketed IPv6
 * address, `localhost`, or an IPv4 form in any base, dotted or a bare number
 * (`2130706433`, `0x7f000001`, `0017700000001`, `0`): Node's URL parser
 * decides what it is. Not after `[`, so `x[0:4317]` is a slice, not an address.
 */
const HOST_PORT_IN_TEXT = /(?<![\w.[-])(\[[0-9a-f:.]+\]|localhost|(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3})\.?:(\d{1,5})(?!\d)/gi;
/**
 * curl's `--resolve name:port:address` (and a `hosts`-style override like it):
 * a request to `http://x:4317/` then goes to the address, and the Host check
 * passes when the header is set to `localhost`. curl takes a numeric address
 * only, dotted or bracketed.
 */
const RESOLVE_IN_TEXT = /:(\d{1,5}):(\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(?![\w.:])/gi;

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 443;
  if (url.protocol === 'http:' || url.protocol === 'ws:') return 80;
  return Number.NaN;
}

/**
 * The URL is this orchestrator's listen address: a loopback host (any
 * spelling, `isLoopbackHostname`) on its port. Only the address — a URL that
 * merely contains `auth-token` in its path is someone else's page.
 */
export function urlIsSelfAddress(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  return isLoopbackHostname(parsed.hostname) && selfPorts.has(effectivePort(parsed));
}

/** The listen address in any spelling Node's URL parser accepts: normalised first, then compared. */
function namesSelfAddress(text: string, patterns: readonly RegExp[] = selfReferences): boolean {
  // Most text has no URL at all: skip the scan for one.
  for (const match of /:[\\/]{2}/.test(text) ? text.matchAll(URL_IN_TEXT) : []) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (urlIsSelfAddress(url)) return true;
    if (patterns.some((r) => r.test(url.href))) return true;
  }
  for (const match of text.matchAll(HOST_PORT_IN_TEXT)) {
    let hostname: string;
    try {
      hostname = new URL(`http://${match[1]}/`).hostname;
    } catch {
      continue;
    }
    if (isLoopbackHostname(hostname) && selfPorts.has(Number(match[2]))) return true;
  }
  for (const match of text.matchAll(RESOLVE_IN_TEXT)) if (selfPorts.has(Number(match[1])) && hostIsLoopback(match[2]!)) return true;
  return false;
}

/** A host word (`127.1`, `localhost`, `::1`, `[::1]`) that Node's URL parser reads as this machine. */
function hostIsLoopback(word: string): boolean {
  const host = word.includes(':') && !word.startsWith('[') ? `[${word}]` : word;
  try {
    return isLoopbackHostname(new URL(`http://${host}/`).hostname);
  } catch {
    return false;
  }
}

/** Programs that open a raw connection to a host and port given as two words. */
const SOCKET_COMMANDS = new Set(['nc', 'ncat', 'netcat', 'telnet']);

/**
 * A raw connection to the listen address, over which an agent can write a
 * request by hand with any Host header: `nc 127.1 4317`, `telnet localhost
 * 4317`, bash's `/dev/tcp/127.0.0.1/4317`. The host and port are separate
 * words, which no URL or `host:port` scan sees.
 */
function opensSocketToSelf(text: string): boolean {
  for (const m of text.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s"']+)\/(\d{1,5})/gi)) if (selfPorts.has(Number(m[2])) && hostIsLoopback(m[1]!)) return true;
  const words = programWords(text);
  if (!SOCKET_COMMANDS.has(commandWord(words[0] ?? ''))) return false;
  return words.some((w, i) => i > 0 && /^\d{1,5}$/.test(words[i + 1] ?? '') && selfPorts.has(Number(words[i + 1])) && hostIsLoopback(w));
}

/** A `Host` header (`Host: localhost`, `@{Host='localhost'}`, `"Host":"127.0.0.1"`) and the name it gives. */
const HOST_HEADER = /(?:^|[\s"'{;,(@])host["']?\s*[:=]\s*["']?(\[[0-9a-f:.]+\]|[^\s"';,}\]:]+)/gi;
/** A port after a colon (`lvh.me:4317`, `"port": 4317`). */
const PORT_IN_TEXT = /:\s*["']?(\d{1,5})(?!\d)/g;

/**
 * `text` cut into statements: at a line end (not continued with `\`, a
 * backtick or `^`), `;`, `&&` and `|`, outside any bracket — so a call or a
 * hash table written over several lines stays one statement.
 */
function statements(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (ch === ';' || ch === '|' || (ch === '&' && text[i + 1] === '&') || (ch === '\n' && !/[\\`^]\r?$/.test(text.slice(Math.max(start, i - 2), i)))) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * A request sent to a listen port under another name with its `Host` header
 * set to a loopback name (`curl -H 'Host: localhost' http://lvh.me:4317/`):
 * public names such as lvh.me and *.nip.io resolve to this machine, and the
 * Control Center answers any request whose Host is a loopback name. The
 * header and the port are one request's only when one statement holds both:
 * a compose file that maps port 4317 for a tracing collector on one line and
 * sets `host: localhost` for a database on another is not a request.
 */
function overridesHostToSelf(text: string): boolean {
  if (!/host/i.test(text)) return false;
  return statements(text).some(
    (part) => /host/i.test(part) && [...part.matchAll(HOST_HEADER)].some((m) => hostIsLoopback(m[1]!)) && [...part.matchAll(PORT_IN_TEXT)].some((m) => selfPorts.has(Number(m[1]))),
  );
}

/**
 * `overridesHostToSelf` over a structured value (a tool input, a JSON file's
 * content): each object read as one request — its own one-line values with
 * its `headers` — so `{ url, headers: { Host } }` counts and a configuration
 * that sets a database `host` in one object and a tracing endpoint on port
 * 4317 in another does not.
 */
function requestOverridesHost(value: unknown, depth = 0): boolean {
  if (depth > 20 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => requestOverridesHost(v, depth + 1));
  // `key: value` side by side, so a command line among them is still cut at its `&&` and `;`. A document in a string
  // (a file's lines, a JSON file) is read on its own by `inputReferencesSelf`.
  const parts: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (/^headers?$/i.test(key) && v && typeof v === 'object') parts.push(JSON.stringify(v));
    else if (typeof v === 'number' || (typeof v === 'string' && v.length <= 4000 && !/[\r\n]/.test(v) && !/^\s*[[{]/.test(v))) parts.push(`${key}: ${v}`);
  }
  if (parts.length && overridesHostToSelf(parts.join(' '))) return true;
  return Object.values(value).some((v) => requestOverridesHost(v, depth + 1));
}

/** The text names the data folder, a key/token file or the listen address (`referencesSelf` without the Host header rule). */
function namesSelf(text: string): boolean {
  return selfReferences.some((r) => r.test(text)) || namesSelfAddress(text);
}

/**
 * True when the text names the Control Center's own data folder, key/token
 * files or listen address. The address is matched in every spelling Node's
 * URL parser normalises (SEC-1): `127.1:4317`, `2130706433:4317`,
 * `[::ffff:127.0.0.1]:4317` and the rest, as curl's `--resolve
 * name:4317:127.0.0.1`, and as another name for this machine on a listen port
 * with a loopback `Host` header in the same statement. It is lexical: a host
 * and port a script computes, or passes to a socket API as two values, is not
 * seen here (`analyse` reads `nc|telnet host port` and `/dev/tcp/host/port`).
 */
export function referencesSelf(text: string): boolean {
  return namesSelf(text) || overridesHostToSelf(text);
}

/**
 * `referencesSelf` for a web address a page requests: the listen address in
 * any spelling, an address written inside it (an open redirect's `?to=` target),
 * the data folder and the rest — but not the key files' bare names, which on
 * another server are ordinary path words (`/octokit/auth-token.js`) and reach
 * nothing of ours. A local file or other scheme is judged by `referencesSelf`.
 */
export function webUrlReferencesSelf(url: URL): boolean {
  if (urlIsSelfAddress(url)) return true;
  const patterns = selfReferences.filter((r) => !KEY_FILE_WORDS.includes(r));
  return patterns.some((r) => r.test(url.href)) || namesSelfAddress(url.href, patterns);
}

/**
 * `referencesSelf` over a structured tool input: its JSON text, and every
 * string in it as it is (JSON escapes a `\`) and read as a URL the way the
 * tool's own `new URL(…)` would (`http:127.1:4317` has no `//` to find in text).
 * The Host header rule reads the input's objects (`requestOverridesHost`) and
 * each string on its own — never the JSON text, where a file's lines run
 * together — and a string that is a JSON document by its objects too.
 */
/** A `..` path segment anywhere in a string: between separators, quotes, brackets or command punctuation. */
const CLIMB = /(?:^|[\\/\s"'`(=:;,|&<>])\.\.(?=$|[\\/\s"'`);,|&<>])/;

/** Every string in a tool input, and every key, as far down as the checks read (20 levels). */
function eachString(input: unknown, visit: (text: string, key: string | null) => void): void {
  const walk = (value: unknown, key: string | null, depth: number): void => {
    if (depth > 20) return;
    if (typeof value === 'string') visit(value, key);
    else if (Array.isArray(value)) for (const v of value) walk(v, key, depth + 1);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        visit(k, null);
        walk(v, k, depth + 1);
      }
    }
  };
  walk(input, null, 0);
}

/**
 * Text a call carries but never acts on as a path or runs: a file's content, the text a patch finds and writes, a
 * request body, a commit message, a page's HTML. A relative import in code (`../../lib`) is relative to its file,
 * and file tools are confined to the task's folders anyway. What a call runs (`script`, `command`, `stdin`, `text`
 * typed into a terminal) is never here.
 */
const CONTENT_KEYS = new Set(['content', 'find', 'replace', 'body', 'message', 'html']);

/** A relative path with a `..` in one word of a command, read from the folder it runs in; null when it is not one. */
function climbWord(raw: string): string | null {
  if (!raw || !CLIMB.test(raw) || /^(?:[A-Za-z]:|[a-z][a-z+.-]*:\/\/|[\\/]{2})/i.test(raw)) return null;
  // `$w\..`, `${w}/..`, `%CD%\..`, and what is left of `"$PWD"\..` once the quotes are split off.
  const token = raw.replace(/^(?:\$\{?[\w:]+\}?|%\w+%)(?=[\\/])/, '').replace(/^[\\/]+(?=\.\.)/, '');
  return /^[\\/]/.test(token) ? null : token;
}

/**
 * Where a tool input's relative paths lead, and where its `cd`s take the shell, read from the folder each part of a
 * command runs in: `bases` are the folders the call starts in (the task's folder, or the call's own `cwd`, or the
 * folder the agent's shell is in), and a `cd`, `pushd` or `Set-Location` moves it for the parts after it. A
 * `..\..\..\acc.db`, or `cd ..` typed three times, names no folder, so the self-reference check, which reads text,
 * never sees that a task whose folder is in the data folder reaches the Control Center's files with it. A path that
 * starts with a variable or a separator (`$w\..`, `"$PWD"\..`) is read from the current folder. Lexical like that
 * check: a folder a variable holds, or one changed by a program, is not followed — the boundary for that is the
 * agent account (docs/systems/security.md#agent-os-boundary).
 */
export function relativeClimbTargets(input: unknown, bases: readonly string[]): string[] {
  const usable = bases.filter((b) => typeof b === 'string' && /^(?:[A-Za-z]:[\\/]|\/)/.test(b));
  if (!usable.length) return [];
  const out = new Set<string>();
  eachString(input, (text, key) => {
    if ((key && CONTENT_KEYS.has(key)) || !(CLIMB.test(text) || /\b(?:cd|chdir|pushd|set-location|sl|push-location)\b/i.test(text))) return;
    for (const base of usable) {
      const pathApi = /^[A-Za-z]:/.test(base) ? path.win32 : path.posix;
      let here = base;
      for (const segment of splitCommands(text)) {
        const words = shellWords(segment.text);
        // A message (`git commit -m "…../shared"`, `-am`, `--message=`) is text, like a file's content.
        const skip = new Set<number>();
        words.forEach((w, i) => {
          if (/^-[A-Za-z]*m$|^--message$/.test(w)) skip.add(i + 1);
          if (/^--message=/.test(w)) skip.add(i);
        });
        for (const [i, word] of words.entries()) {
          if (skip.has(i)) continue;
          for (const raw of word.split(/[\s"'`;,|&<>()=]+/)) {
            const token = climbWord(raw);
            if (token) out.add(pathApi.resolve(here, token));
          }
        }
        if (!CHANGES_DIRECTORY.has(commandWord(words[0] ?? ''))) continue;
        const args = words.slice(1);
        const flagged = args.findIndex((w) => /^-(?:path|literalpath)$/i.test(w));
        const target = flagged >= 0 ? args[flagged + 1] : args.find((w) => !w.startsWith('-'));
        // A folder only known when it runs (`cd $w`, `cd -`, `cd ~`) is not followed: the parts after it are read
        // from where the shell was.
        if (!target || /[$`%~]/.test(target) || /^-$/.test(target)) continue;
        here = pathApi.resolve(here, target);
        out.add(here);
      }
    }
  });
  return [...out];
}

/**
 * A tool input with every path inside one of the task's own folders (`roots`: its worktree, a worker's
 * checkout) written relative to it: `C:\…\AIDevControlCenter\worktrees\app\TASK-0022\src\a.ts` becomes
 * `.\src\a.ts`. A worktree left in the data folder would otherwise read as the Control Center's files, and every
 * call naming it would be refused; a whole-tree command on the task's own folder reads as one (`git checkout -- .`).
 * Only for judging a call — never run. A path is written relative to `cwd`, the folder the call runs in, when that
 * is given: a sibling repository of a multi-repository task becomes `..\api`, never a `.` the release gate would
 * read as the call's own folder. The file name is kept, so sensitive-file rules still apply.
 *
 * `failClosed` (for the self-reference check): an input with a `..` segment in any string is left as written,
 * so a climb out of the root is judged in the absolute form the check recognises, however it is spelled — a space
 * or bracket in the path, the root in its own quotes, in a variable, or in another argument. Only its `cwd`, when
 * that has no climb itself, is still written relative: a climb from it is resolved by `relativeClimbTargets`.
 */
export function relativizeOwnRoots<T>(input: T, roots: readonly string[], cwd?: string, options: { failClosed?: boolean } = {}): T {
  const absolute = (r: unknown): r is string => typeof r === 'string' && /^(?:[A-Za-z]:[\\/]|\/)./.test(r);
  const usable = [...new Set(roots.filter(absolute))];
  if (!usable.length) return input;
  let climbs = false;
  if (options.failClosed) {
    eachString(input, (text, key) => {
      if (!(key && CONTENT_KEYS.has(key))) climbs ||= CLIMB.test(text);
    });
  }
  const base = absolute(cwd) ? cwd : null;
  const rules = usable.map((root) => {
    const windows = /^[A-Za-z]:/.test(root);
    const pathApi = windows ? path.win32 : path.posix;
    const normal = pathApi.normalize(root).replace(/[\\/]+$/, '');
    const pattern = normal.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
    // The root, then the rest of the path up to whatever ends a path in a command or text.
    const re = new RegExp(`${pattern}(?=$|[\\\\/\\s"'\`;,|&<>()])([^\\s"'\`;,|&<>()]*)`, windows ? 'gi' : 'g');
    return { re, pathApi, normal, windows };
  });
  const rewrite = (text: string): string => {
    let out = text;
    for (const { re, pathApi, normal, windows } of rules) {
      out = out.replace(re, (whole: string, rest: string) => {
        const full = pathApi.normalize(`${normal}${pathApi.sep}${rest.replace(/[\\/]+/g, pathApi.sep)}`).replace(/[\\/]+$/, '');
        const inside = windows ? full.toLowerCase() === normal.toLowerCase() || full.toLowerCase().startsWith(`${normal.toLowerCase()}${pathApi.sep}`) : full === normal || full.startsWith(`${normal}/`);
        if (!inside) return whole;
        if (!base || /^[A-Za-z]:/.test(base) !== windows) return `.${full.slice(normal.length) || ''}`;
        const rel = pathApi.relative(pathApi.normalize(base), full);
        // Another drive has no relative form: judged as written.
        if (pathApi.isAbsolute(rel)) return whole;
        return rel === '' ? '.' : rel.startsWith('..') ? rel : `.${pathApi.sep}${rel}`;
      });
    }
    return out;
  };
  if (climbs) {
    // Only the folder the call runs in is still its own: a climb from it is resolved by relativeClimbTargets.
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const given = (input as { cwd?: unknown }).cwd;
    return typeof given === 'string' && !CLIMB.test(given) ? ({ ...input, cwd: rewrite(given) } as T) : input;
  }
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 20) return value;
    if (typeof value === 'string') return rewrite(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewrite(k), walk(v, depth + 1)]));
    return value;
  };
  return walk(input, 0) as T;
}

export function inputReferencesSelf(input: unknown): boolean {
  if (namesSelf(JSON.stringify(input) ?? '') || requestOverridesHost(input)) return true;
  const strings: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 20) return;
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, depth + 1);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        strings.push(k);
        walk(v, depth + 1);
      }
    }
  };
  walk(input, 0);
  for (const s of strings) {
    if (namesSelf(s)) return true;
    let document: unknown;
    if (/^\s*[[{]/.test(s)) {
      try {
        document = JSON.parse(s);
      } catch {
        /* not JSON: read as text */
      }
    }
    if (document && typeof document === 'object' ? requestOverridesHost(document) : overridesHostToSelf(s)) return true;
    let href: string;
    try {
      href = new URL(s.trim()).href;
    } catch {
      continue;
    }
    // The address as a URL spells it; a URL parser drops line breaks, so the Host header rule would run lines together.
    if (href !== s && namesSelf(href)) return true;
  }
  return false;
}

/**
 * Judge `text` into `acc`. `leftFolder`: an earlier command of the line
 * changed directory out of the working folder (`cd / && …`), so a relative
 * path no longer means inside it.
 */
function analyse(text: string, acc: Accumulator, depth: number, leftFolder = false): void {
  if (depth > 4) {
    note(acc, 'elevated', 4, 'Deeply nested shells', ['code-execution']);
    return;
  }
  // Also as the shell joins quoted pieces: `curl "http://127.1":4317/` requests http://127.1:4317/.
  if (referencesSelf(text) || namesSelfAddress(shellWords(text).join(' '))) note(acc, 'dangerous', 5, "Reaches the Control Center's own token, data folder or API", ['credentials']);
  // Encoded PowerShell is judged by what it decodes to.
  for (const decoded of decodeEncodedCommands(text)) {
    note(acc, 'elevated', 4, 'Runs an encoded PowerShell command', ['code-execution']);
    acc.readOnly = false;
    analyse(decoded, acc, depth + 1);
  }
  // Download-and-execute spans pipeline segments, so it is checked on the whole text.
  if (DOWNLOAD.test(text) && EXECUTE.test(text)) note(acc, 'dangerous', 5, 'Downloads and runs code', ['network', 'code-execution']);
  // Decoded on the spot and run: nobody reviewing the line can see what runs; a literal payload is judged too.
  if (DECODE.test(text) && RUNS_INPUT.test(text)) {
    note(acc, 'elevated', 4, 'Runs base64-decoded code', ['code-execution']);
    for (const decoded of decodeBase64Pipes(text)) analyse(decoded, acc, depth + 1);
  }

  const segments = splitCommands(text);
  // What one command leaves for the next: a file downloaded here and run a few commands later.
  const downloaded = new Set<string>();
  // The segment reads a download's output through a pipe (`curl … | tee x.sh`).
  let pipedFromDownload = false;
  let outside = leftFolder;
  segments.forEach((segment, index) => {
    const inner = unwrapInterpreter(segment.text);
    if (downloaded.size && runsDownloadedFile(segment.text, downloaded, 0)) note(acc, 'dangerous', 5, 'Downloads and runs code', ['network', 'code-execution']);
    // A download is saved by its own output option (below), a redirection (`curl … > x.sh`) or a `| tee x.sh` / `| Out-File x.ps1` it feeds.
    pipedFromDownload = DOWNLOAD.test(segment.text) || (segment.joinedBy === '|' && pipedFromDownload);
    if (pipedFromDownload) for (const name of savedFiles(segment.text)) downloaded.add(name);
    if (leavesWorkingFolder(segment.text)) outside = true;
    if (inner !== null) {
      analyse(inner, acc, depth + 1, outside);
      return;
    }
    const variants = [segment.text];
    const expanded = expandAlias(segment.text);
    if (expanded && expanded !== segment.text) variants.push(expanded);
    // `git -C repo gc --prune=now` is `git gc --prune=now` to every Git rule.
    const plainGit = withoutGitGlobals(segment.text);
    if (plainGit !== segment.text) variants.push(plainGit);
    for (const variant of variants) {
      for (const pattern of PATTERNS) if (pattern.test.test(variant)) note(acc, pattern.risk, pattern.level, pattern.reason, pattern.effects);
      for (const hint of EFFECT_HINTS) if (hint.test.test(variant)) for (const e of hint.effects) acc.effects.add(e);
      if (DOWNLOAD.test(variant)) for (const name of downloadedFiles(variant)) downloaded.add(name);
    }
    const words = shellWords(segment.text);
    if (gitCalls(words).some((call) => call.configs.some((kv) => DATA_LOSS_CONFIG.test(kv)))) note(acc, 'dangerous', 5, 'Deletes Git data that may not be recoverable', ['git']);
    if (opensSocketToSelf(segment.text)) note(acc, 'dangerous', 5, "Reaches the Control Center's own token, data folder or API", ['credentials']);
    const transfer = transferOf(segments, index);
    if (transfer) {
      if (transfer.files.some(isSecretFile)) note(acc, 'elevated', 4, 'Sends a secret file over the network', ['credentials', 'network']);
      else if (!transfer.hosts?.length || !transfer.hosts.every(isLoopbackHostname)) note(acc, 'elevated', 3, transfer.reason, ['network']);
    }
    const found = findDeletes(segment.text, outside);
    if (found === 'inside') note(acc, 'elevated', 3, 'Deletes the files a search finds', ['filesystem']);
    else if (found === 'outside') note(acc, 'dangerous', 5, 'Deletes the files a search finds outside the working folder', ['filesystem']);
    else if (found === 'git') note(acc, 'dangerous', 5, 'Deletes Git data that may not be recoverable', ['git', 'filesystem']);
    if (!segmentReadOnly(segment.text)) acc.readOnly = false;
  });
}

// ---- Rules that read a command's words (SEC-1) --------------------------------------------------

/** Basename of a path in either separator style, lowercased. */
function baseName(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).toLowerCase();
}

/** Hostnames of the URLs among the words (unparseable ones left out). */
function urlHosts(words: string[]): string[] {
  const hosts: string[] = [];
  for (const w of words) {
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(w)) continue;
    try {
      hosts.push(new URL(w).hostname);
    } catch {
      /* not a URL */
    }
  }
  return hosts;
}

/** A file `sensitiveFileReason` names (curl's `;type=…` suffix and quotes left off). */
function isSecretFile(file: string): boolean {
  return Boolean(sensitiveFileReason(unquote(file).replace(/;.*$/, '')));
}

/** Words that print a file, or an encoding of it, to standard output (the left side of `cat .env | nc host 443`, `base64 .env | nc …`). */
const READS_FILE = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'base64', 'xxd', 'od', 'gpg']);
/** Archivers whose output, piped on, carries the files they were given (`tar czf - . | nc host 443`). */
const ARCHIVERS = new Set(['tar', 'zip', '7z', '7za', 'gzip', 'bzip2', 'xz', 'zstd', 'compress-archive']);
/** Words that end one command inside a substitution (`$(cat .env | base64)`). */
const SEPARATOR_WORD = /^(?:\||\|\||&&|;|&)$/;

/**
 * Files a command substitution reads onto the command line: `$(cat f)`,
 * `$(< f)`, `` `cat f` `` and PowerShell's `(Get-Content f)`.
 */
function inlinedFiles(text: string): string[] {
  const files: string[] = [];
  for (const m of text.matchAll(/\$\(([^()]*)\)|`([^`]*)`|\(([^()]*)\)/g)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (inner.startsWith('<')) {
      const file = shellWords(inner.slice(1))[0];
      if (file) files.push(file);
      continue;
    }
    if (!READS_FILE.has(commandWord(inner))) continue;
    const words = shellWords(inner).slice(1);
    const end = words.findIndex((w) => SEPARATOR_WORD.test(w));
    files.push(...(end >= 0 ? words.slice(0, end) : words).filter((w) => !w.startsWith('-')));
  }
  return files;
}

/**
 * Files a segment reads on standard input: `< file` or `0< file`, or what the
 * command piped into it prints — a `cat file`, an archive (`tar czf - .`), or
 * a secret file a substitution put on its line (`echo "$(cat .env)"`).
 */
function stdinFiles(segments: Segment[], index: number, words: string[]): string[] {
  const files: string[] = [];
  words.forEach((w, i) => {
    if (/^0?<$/.test(w) && words[i + 1]) files.push(words[i + 1]!);
    else if (/^0?<[^<(]/.test(w)) files.push(w.replace(/^0?</, ''));
  });
  const previous = segments[index - 1];
  if (segments[index]!.joinedBy === '|' && previous) {
    const printed = programWords(previous.text);
    const word = commandWord(printed[0] ?? '');
    const operands = printed.slice(1).filter((w) => !w.startsWith('-') && !/^\d*[<>]/.test(w));
    if (READS_FILE.has(word)) files.push(...operands);
    else if (ARCHIVERS.has(word)) files.push(...(operands.length ? operands : ['.']));
    files.push(...inlinedFiles(previous.text).filter(isSecretFile));
  }
  return files;
}

/** A value an option takes: attached (`--data=@x`, `-d@x`) or the next word. */
function optionValue(words: string[], i: number, attached: string | undefined): { value: string | undefined; next: number } {
  if (attached !== undefined && attached !== '') return { value: attached, next: i };
  return { value: words[i + 1], next: i + 1 };
}

/** curl's short options that take no value: they may lead a cluster that ends in one that does (`-sSd @x`, `-fsSLo x.sh`). */
const CURL_FLAGS = '[sSLfkvqiIGjJlnNpRZO0-9#]';
const CURL_SHORT_UPLOAD = new RegExp(`^-(${CURL_FLAGS}*)([dFTHb])(.*)$`);
/** curl's `-O` (save under the URL's own name) anywhere in a cluster of flags: `-O`, `-LO`, `-OL`, `-fsSLO`. */
const CURL_REMOTE_NAME = new RegExp(`^-${CURL_FLAGS}*O${CURL_FLAGS}*$`);
/** `-o file` (curl), `-O file` (wget), alone or ending a cluster of flags (`-fsSLo x.sh`, `-qO-`). */
const SHORT_OUTPUT = new RegExp(`^-(${CURL_FLAGS}*|[qcNv]*)([oO])(.*)$`);

/**
 * Files curl sends: `-d`, `--data…` or `--json` with `@file`, `--data-urlencode
 * name@file`, `-F name=@file|<file`, `-T file`, a file of headers (`-H
 * @file`: each line is sent as a header) and a cookie file (`-b file`, a value
 * without `=`).
 */
function curlUploads(segments: Segment[], index: number, words: string[]): string[] {
  const files: string[] = [];
  let stdin = false;
  const add = (file: string | undefined) => {
    if (!file) return;
    if (file === '-' || file === '.') stdin = true;
    else files.push(file);
  };
  const data = (v: string | undefined, urlencode: boolean) => {
    if (v) add((urlencode ? /^[^=@]*@(.+)$/ : /^@(.+)$/).exec(v)?.[1]);
  };
  const form = (v: string | undefined) => {
    if (v) add(/^[^=]*=[@<](.+)$/.exec(v)?.[1]);
  };
  const cookies = (v: string | undefined) => {
    if (v && !v.includes('=')) add(v);
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^--(data(?:-binary|-ascii|-urlencode)?|json)(?:=(.*))?$/i.exec(w))) {
      const { value, next } = optionValue(words, i, m[2]);
      data(value, m[1]!.toLowerCase() === 'data-urlencode');
      i = next;
    } else if ((m = /^--(header|cookie)(?:=(.*))?$/i.exec(w))) {
      const { value, next } = optionValue(words, i, m[2]);
      if (m[1]!.toLowerCase() === 'header') data(value, false);
      else cookies(value);
      i = next;
    } else if ((m = /^--form(?:=(.*))?$/i.exec(w))) {
      const { value, next } = optionValue(words, i, m[1]);
      form(value);
      i = next;
    } else if ((m = /^--upload-file(?:=(.*))?$/i.exec(w))) {
      const { value, next } = optionValue(words, i, m[1]);
      add(value);
      i = next;
    } else if ((m = CURL_SHORT_UPLOAD.exec(w))) {
      // `-d @x`, `-d@x`, and a cluster that ends in the option (`-sSd @x`).
      const { value, next } = optionValue(words, i, m[3]);
      if (m[2] === 'd' || m[2] === 'H') data(value, false);
      else if (m[2] === 'F') form(value);
      else if (m[2] === 'b') cookies(value);
      else add(value);
      i = next;
    }
  }
  return stdin ? [...files, ...stdinFiles(segments, index, words)] : files;
}

/** Commands `transferOf` reads (Copy-Item and its aliases only with `-ToSession`/`-FromSession`). */
const TRANSFER_COMMANDS = new Set(['invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'plink', 'scp', 'pscp', 'sftp', 'rsync', 'gh', 'aws', 'gsutil', 'gcloud', 'az']);

/**
 * The words of a command as its program receives them: the call operator
 * (`& x`), leading `VAR=value` assignments and wrappers (`env`, `timeout 60`,
 * `nice`…) removed, and leading redirections (`< .env nc host 443`) moved
 * after it, where they mean the same.
 */
function programWords(text: string): string[] {
  const all = shellWords(text.trim().replace(/^&\s+/, ''));
  const redirections: string[] = [];
  let i = 0;
  while (i < all.length) {
    const w = all[i]!;
    if (/^\d*(?:<|>>?|&>)$/.test(w) && i + 1 < all.length) {
      redirections.push(w, all[i + 1]!);
      i += 2;
    } else if (/^\d*(?:<(?![<(])|>>?(?!&)|&>)\S/.test(w)) {
      redirections.push(w);
      i++;
    } else break;
  }
  return [...withoutWrappers(all.slice(i)), ...redirections];
}

/**
 * Files a GitHub gist or release, or a cloud storage copy, uploads:
 * `gh gist create .env`, `gh gist edit <id> -a .env`, `gh release upload v1
 * .env`, `aws s3 cp .env s3://b/`, `gsutil cp`, `gcloud storage cp`, `az
 * storage blob upload -f`. `-` is standard input. Null for anything else.
 */
function storageUploads(words: string[]): string[] | null {
  const word = commandWord(words[0] ?? '');
  /** Non-option words from `from`, skipping the values of `values`; the values of `files` are files too. */
  const operands = (from: number, values: RegExp, files?: RegExp): string[] => {
    const found: string[] = [];
    for (let i = from; i < words.length; i++) {
      const w = words[i]!;
      if (files?.test(w)) {
        if (words[i + 1] !== undefined) found.push(words[++i]!);
      } else if (values.test(w)) i++;
      else if (!w.startsWith('-') || w === '-') found.push(w);
    }
    return found;
  };
  const toBucket = (from: number, scheme: RegExp): string[] | null => {
    const found = operands(from, /^--?(?:exclude|include|acl|storage-class|region|profile|endpoint-url|content-type|cache-control|metadata|sse|sse-kms-key-id|grants|expires|[hpxzZ])$/);
    return found.length >= 2 && scheme.test(found.at(-1)!) ? found.slice(0, -1) : null;
  };
  if (word === 'gh' && words[1] === 'gist' && /^(?:create|new)$/.test(words[2] ?? '')) return operands(3, /^(?:-d|--desc|-f|--filename)$/);
  if (word === 'gh' && words[1] === 'gist' && words[2] === 'edit') {
    const [, ...files] = operands(3, /^(?:-d|--desc|-f|--filename)$/);
    return [...files, ...words.flatMap((w, i) => (/^(?:-a|--add)$/.test(w) && words[i + 1] ? [words[i + 1]!] : []))];
  }
  if (word === 'gh' && words[1] === 'release' && /^(?:create|upload)$/.test(words[2] ?? '')) {
    return operands(3, /^(?:-t|--title|-n|--notes|-F|--notes-file|--target|--discussion-category|--notes-start-tag|-R|--repo)$/).slice(1);
  }
  if (word === 'aws' && words[1] === 's3' && /^(?:cp|mv|sync)$/.test(words[2] ?? '')) return toBucket(3, /^s3:\/\//i);
  if (word === 'gsutil') {
    const sub = words.findIndex((w, i) => i > 0 && /^(?:cp|mv|rsync)$/.test(w));
    return sub > 0 ? toBucket(sub + 1, /^gs:\/\//i) : null;
  }
  if (word === 'gcloud' && words[1] === 'storage' && /^(?:cp|mv|rsync)$/.test(words[2] ?? '')) return toBucket(3, /^gs:\/\//i);
  if (word === 'az' && words[1] === 'storage' && words[2] === 'blob' && /^upload(?:-batch)?$/.test(words[3] ?? '')) {
    return words.flatMap((w, i) => (/^(?:-f|--file|-s|--source)$/.test(w) && words[i + 1] ? [words[i + 1]!] : []));
  }
  return null;
}

/**
 * A command that sends files to, or copies files with, another machine:
 * HTTP uploads (curl, wget, `Invoke-RestMethod -InFile`), raw sockets fed a
 * file (`nc host 443 < .env`) and remote copy tools (scp, sftp, rsync to a
 * host). `hosts` are the machines it reaches, when they can be read.
 */
function transferOf(segments: Segment[], index: number): { reason: string; files: string[]; hosts: string[] | null } | null {
  const text = segments[index]!.text;
  const words = programWords(text);
  const word = commandWord(words[0] ?? '');
  if (!TRANSFER_COMMANDS.has(word) && !/^copy-item$|^cpi$|^copy$|^cp$/.test(word)) return null;
  if (['invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr', 'curl', 'wget'].includes(word)) {
    const files: string[] = [];
    if (word === 'curl') files.push(...curlUploads(segments, index, words));
    words.forEach((w, i) => {
      const m = word === 'wget' ? /^--(?:post|body)-file(?:=(.*))?$/i.exec(w) : null;
      const v = m ? optionValue(words, i, m[1]).value : /^-inf(?:i(?:le?)?)?$/i.test(w) ? words[i + 1] : undefined;
      if (v) files.push(v);
    });
    // A secret file's content put on the line: `curl -d "$(cat .env)"`, `iwr … -Body (Get-Content .env -Raw)`.
    files.push(...inlinedFiles(text).filter(isSecretFile));
    if (files.length) return { reason: 'Uploads files to another machine', files, hosts: urlHosts(words) };
  }
  if (['nc', 'ncat', 'netcat', 'socat', 'telnet'].includes(word)) {
    const files = [...stdinFiles(segments, index, words), ...words.flatMap((w) => /^(?:g?open|file):([^,]+)/i.exec(w)?.[1] ?? [])];
    const host = words.slice(1).find((w) => !w.startsWith('-') && !/^\d*[<>]/.test(w) && !/^\d+$/.test(w) && !/^[a-z0-9-]+:/i.test(w));
    if (files.length) return { reason: 'Uploads files to another machine', files, hosts: host ? [host] : null };
  }
  if (word === 'ssh' || word === 'plink') {
    // A file fed to a remote command: `ssh host "cat > x" < .env`, `cat .env | ssh host tee x`.
    const files = stdinFiles(segments, index, words);
    let host: string | undefined;
    for (let i = 1; i < words.length && host === undefined; i++) {
      const w = words[i]!;
      if (/^-(?:[bcDEeFIiJLlmOopQRSWwP]|pw|hostkey|proxycmd)$/.test(w)) i++;
      else if (!w.startsWith('-') && !/^\d*[<>]/.test(w)) host = w.replace(/^.*@/, '');
    }
    if (files.length) return { reason: 'Uploads files to another machine', files, hosts: host ? [host] : null };
  }
  const stored = storageUploads(words);
  if (stored) {
    const files = stored.flatMap((f) => (f === '-' ? stdinFiles(segments, index, words) : [f]));
    if (files.length) return { reason: 'Uploads files to another machine', files, hosts: null };
  }
  if (['scp', 'pscp', 'sftp', 'rsync'].includes(word)) {
    // `host:path`, `user@host:path`, `host::module`, `scp://…`, `rsync://…`; a one-letter host too (an
    // ssh config alias: `scp .env s:/tmp`), but never a drive letter with a backslash (`C:\x`).
    const remote = /^(?:[a-z][a-z\d+.-]*:\/\/([^/@]+@)?([^/:]+)|(?:[^@\s/\\:]+@)?(\[[^\]]+\]|[^\s/\\:@]{2,}|[^\s/\\:@](?=:(?!\\))):)/i;
    const takesValue = word === 'rsync' ? /^(?:-e|--(?:rsh|exclude|include|filter|files-from|exclude-from|include-from|password-file|port))$/ : /^-[PiolFcJSDb]$/;
    const operands: string[] = [];
    for (let i = 1; i < words.length; i++) {
      if (takesValue.test(words[i]!)) i++;
      else if (!words[i]!.startsWith('-')) operands.push(words[i]!);
    }
    const hosts = operands.flatMap((o) => {
      const m = remote.exec(o);
      if (!m) return [];
      return [(m[2] ?? m[3] ?? '').replace(/^.*@/, '')];
    });
    if (word === 'sftp' || hosts.length) {
      const destinationRemote = operands.length > 1 && remote.test(operands.at(-1)!);
      return { reason: 'Copies files to or from another machine', files: destinationRemote ? operands.slice(0, -1) : [], hosts: hosts.length ? hosts : null };
    }
  }
  if (/^copy-item$|^cpi$|^copy$|^cp$/.test(word) && /\s-(?:To|From)Session\b/i.test(text)) {
    return { reason: 'Copies files to or from another machine', files: /\s-ToSession\b/i.test(text) ? words.slice(1).filter((w) => !w.startsWith('-') && !w.startsWith('$')) : [], hosts: null };
  }
  return null;
}

/** Commands that save what they download under a name the command line gives (or the URL's own). */
const DOWNLOADERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'bitsadmin']);

/** Files a download command writes: `-o/--output`, `-OutFile`, `-O` (the URL's name), wget's default name. */
function downloadedFiles(text: string): string[] {
  const words = shellWords(text.replace(/^&\s+/, ''));
  const word = commandWord(text);
  const names: string[] = [];
  for (const m of text.matchAll(/DownloadFile\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/gi)) names.push(baseName(m[1]!));
  if (!DOWNLOADERS.has(word)) return names.filter(Boolean);
  const remoteNames = () => {
    for (const w of words) {
      if (!/^(?:https?|ftp):\/\//i.test(w)) continue;
      try {
        const name = baseName(new URL(w).pathname);
        if (name) names.push(name);
      } catch {
        /* not a URL */
      }
    }
  };
  let named = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^--output(?:-document)?(?:=(.*))?$/i.exec(w))) {
      const { value, next } = optionValue(words, i, m[1]);
      if (value && value !== '-') names.push(baseName(value));
      named = true;
      i = next;
    } else if (/^-(?:outf(?:i(?:le?)?)?|destination)$/i.test(w) && words[i + 1]) {
      names.push(baseName(words[++i]!));
      named = true;
    } else if (/^--remote-name(?:-all)?$/i.test(w)) {
      remoteNames();
      named = true;
    } else if (word === 'curl' && CURL_REMOTE_NAME.test(w)) {
      remoteNames();
      named = true;
    } else if ((m = SHORT_OUTPUT.exec(w))) {
      const { value, next } = optionValue(words, i, m[3]);
      if (value && value !== '-') names.push(baseName(value));
      named = true;
      i = next;
    }
  }
  // wget and bitsadmin name the file themselves when told nothing.
  if (!named && word === 'wget') remoteNames();
  if (word === 'bitsadmin' && words.length > 2) names.push(baseName(words.at(-1)!));
  return names.filter(Boolean);
}

/**
 * Where a command writes its standard output: `> f`, `>> f`, `1> f`, `&> f`,
 * PowerShell's `*> f` — not `2> f` (errors only) or `>&2`.
 */
const REDIRECT_OUT = /(?:^|[^\d&<>=-])[1&*]?>>?(?![&>])\s*("[^"]*"|'[^']*'|[^\s;&|<>"']+)/g;
/** Commands that write what they are piped to a file: `| tee f`, `| Out-File f`, `| Set-Content f`. */
const SAVERS = new Set(['tee', 'tee-object', 'out-file', 'set-content', 'add-content']);

/** Files a segment saves its input or output to: redirections, and the files `tee`/`Out-File`/`Set-Content` write. */
function savedFiles(text: string): string[] {
  const names = [...text.matchAll(REDIRECT_OUT)].map((m) => baseName(unquote(m[1]!)));
  if (SAVERS.has(commandWord(text))) {
    const words = shellWords(text.replace(/^&\s+/, ''));
    const flagged = words.findIndex((w, i) => i > 0 && /^-(?:file(?:path)?|path|literalpath)$/i.test(w));
    const files = flagged > 0 ? [words[flagged + 1] ?? ''] : words.slice(1).filter((w) => !w.startsWith('-'));
    names.push(...files.map(baseName));
  }
  return names.filter(Boolean);
}

/** Programs that run the script or installer they are given. */
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.', 'pwsh', 'powershell', 'python', 'python3', 'py', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'cscript', 'wscript', 'msiexec', 'start-process', 'saps', 'start', 'rundll32', 'regsvr32']);

/**
 * Commands that run the command after them, and which of their options take
 * a value (`timeout -s KILL 60 bash x.sh`); `operands` are words of their own
 * before that command (timeout's duration).
 */
const WRAPPERS: Readonly<Record<string, { values?: RegExp; operands?: number }>> = {
  env: { values: /^(?:-u|--unset|-C|--chdir)$/ },
  timeout: { values: /^(?:-s|--signal|-k|--kill-after)$/, operands: 1 },
  nohup: {},
  exec: { values: /^-a$/ },
  nice: { values: /^(?:-n|--adjustment)$/ },
  command: {},
  builtin: {},
  time: { values: /^(?:-f|--format|-o|--output)$/ },
  setsid: {},
  stdbuf: { values: /^-[ioe]$/ },
  xargs: { values: /^(?:-[aEdIiLlnPs]|--(?:arg-file|eof|delimiter|replace|max-lines|max-args|max-procs|max-chars))$/ },
};

/** The command a line of words runs once leading `VAR=value` assignments and wrappers (`env`, `timeout 60`, `nohup`, `exec`…) are removed. */
export function withoutWrappers(words: readonly string[]): string[] {
  let i = 0;
  for (let guard = 0; guard < 8; guard++) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const wrapper = WRAPPERS[baseName(words[i] ?? '').replace(/\.exe$/, '')];
    if (!wrapper) break;
    i++;
    while (i < words.length && words[i]!.startsWith('-') && words[i] !== '-') {
      if (words[i] === '--') {
        i++;
        break;
      }
      if (wrapper.values?.test(words[i]!)) i++;
      i++;
    }
    i += wrapper.operands ?? 0;
  }
  return words.slice(i);
}

/** The segment runs one of the files an earlier command downloaded: as the program, or as the script a runner is given. */
function runsDownloadedFile(text: string, downloaded: ReadonlySet<string>, depth: number): boolean {
  const inner = unwrapInterpreter(text);
  if (inner !== null) return depth < 4 && splitCommands(inner).some((s) => runsDownloadedFile(s.text, downloaded, depth + 1));
  const all = shellWords(text);
  if (all[0] === '&') all.shift();
  const words = withoutWrappers(all);
  const first = words[0];
  if (!first) return false;
  if (downloaded.has(baseName(first))) return true;
  if (!RUNNERS.has(baseName(first).replace(/\.exe$/, ''))) return false;
  const args = words.slice(1);
  // The script is the first operand, or the value of `-File`, `-FilePath` or msiexec's `/i`.
  const flagged = args.findIndex((w) => /^(?:-f(?:ile(?:path)?)?|\/i|\/package)$/i.test(w));
  const script = flagged >= 0 ? args[flagged + 1] : args.find((w) => !/^-|^\/[a-z]+$/i.test(w));
  return Boolean(script && downloaded.has(baseName(script)));
}

/** A relative path below the working folder: not absolute, not `~`/`$VAR`/`%VAR%`, no `..`, not `cd -`. */
function insideWorkingFolder(p: string): boolean {
  return p !== '-' && !/^(?:[\\/~$%]|[a-z]:)/i.test(p) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/** Commands that change the directory the rest of the line runs in. */
const CHANGES_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

/** The segment changes directory out of the working folder (`cd /`, `cd ~`, `cd ..`, a bare `cd`). */
function leavesWorkingFolder(text: string): boolean {
  return wordsLeaveWorkingFolder(shellWords(text.replace(/^[({]\s*/, '')));
}

function wordsLeaveWorkingFolder(words: readonly string[]): boolean {
  if (!CHANGES_DIRECTORY.has(commandWord(words[0] ?? ''))) return false;
  const args = words.slice(1);
  const flagged = args.findIndex((w) => /^-(?:path|literalpath)$/i.test(w));
  const target = flagged >= 0 ? args[flagged + 1] : args.find((w) => !w.startsWith('-') || w === '-');
  return !target || !insideWorkingFolder(target);
}

/**
 * `find … -delete` (or `-exec rm`): 'git' when a starting folder is inside
 * `.git`, 'inside' when every starting folder is relative and below the
 * working folder (and the line has not changed directory out of it),
 * 'outside' otherwise. find's leading options (`-H`, `-L`, `-P`, `-D opts`,
 * `-O3`, BSD's `-E`/`-X`/`-f path`, `--`) come before the starting folders.
 */
function findDeletes(text: string, leftFolder: boolean): 'inside' | 'outside' | 'git' | null {
  const t = text.replace(/^[({]\s*/, '').replace(/\s*[)}]\s*$/, '');
  // Through a wrapper too: `env find / -delete`, `timeout 60 find ~ -delete`, `FOO=1 find …`.
  const words = programWords(t);
  if (commandWord(words[0] ?? '') !== 'find') return null;
  const deletes = words.some((w, i) => w === '-delete' || (/^-(?:exec|execdir|ok|okdir)$/.test(w) && /^(?:.*[\\/])?(?:rm|shred|unlink)$/.test(words[i + 1] ?? '')));
  if (!deletes) return null;
  const starts: string[] = [];
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') {
      i++;
      break;
    }
    if (/^-[HLPEXdsx]+$/.test(w) || /^-O\d*$/.test(w)) continue;
    if (w === '-D') i++;
    else if (w === '-f' && words[i + 1] !== undefined) starts.push(words[++i]!);
    else break;
  }
  for (; i < words.length; i++) {
    if (/^[-(!]/.test(words[i]!)) break;
    starts.push(words[i]!);
  }
  if (!starts.length) starts.push('.');
  if (starts.some((p) => /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(p))) return 'git';
  return !leftFolder && starts.every(insideWorkingFolder) ? 'inside' : 'outside';
}

/**
 * One shell word as the shell joins it: unquoted characters and quoted runs
 * (`key="a b"`, `'x y'z`), one character or one quoted run per step so a
 * failed match never backtracks over the ways to split a run.
 */
const SHELL_WORD = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;
/**
 * Git's global options between `git` and its subcommand (`git -C repo`,
 * `git -c key=value`, `git -c user.name="A B"`, `--git-dir=…`, `--no-pager`),
 * so the subcommand rules judge `git -C repo gc --prune=now` as `git gc
 * --prune=now`.
 */
const GIT_GLOBALS = new RegExp(
  String.raw`\bgit((?:\s+(?:-[Cc]\s+${SHELL_WORD}|--(?:git-dir|work-tree|namespace|config-env|super-prefix)(?:=${SHELL_WORD}|\s+${SHELL_WORD})|--exec-path(?:=${SHELL_WORD})?|--(?:no-pager|paginate|bare|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-optional-locks|no-advice|no-lazy-fetch)|-[pP]))+)(?=\s)`,
  'gi',
);

function withoutGitGlobals(text: string): string {
  return text.replace(GIT_GLOBALS, 'git');
}

// ---- Where a command line pushes, and whether it merges a pull request (SEC-1) ---------------------

/**
 * A Git invocation among a command's words, read option by option: the
 * index of its subcommand (-1 when there is none), its `-c key=value`
 * settings (`--config-env` too, its value unread), the folders below the
 * working folder `-C` moves it to, in order, and whether `-C` out of the
 * working folder (or to a folder only known when it runs), `--git-dir` or
 * `--work-tree` points it at another repository. `end` is where the next
 * invocation starts: rules read its arguments up to there, so a segment of
 * many `git` words stays linear.
 */
interface GitCall {
  at: number;
  sub: number;
  end: number;
  configs: string[];
  chdir: string[];
  elsewhere: boolean;
}

/**
 * A word that runs Git: `git`, a path to it, and the name as a shell reads
 * an escape inside it (`g\it` in bash, `g^it` in cmd, ``g`it`` in PowerShell).
 */
function isGitProgram(word: string): boolean {
  return /^git(?:\.exe)?$/i.test(baseName(word)) || /^git(?:\.exe)?$/i.test(word.slice(word.lastIndexOf('/') + 1).replace(/[\\^`]/g, ''));
}

/**
 * Git's own programs for a push, as Git's libexec folder holds them
 * (`/usr/lib/git-core/git-push`, `…\mingw64\libexec\git-core\git-send-pack.exe`),
 * read as `git push`, `git send-pack`, `git http-push`: as the program, or as
 * a path anywhere on the line (`xargs /usr/lib/git-core/git-push origin`).
 */
function withGitPrograms(words: readonly string[]): string[] {
  return words.flatMap((w, i) => {
    const m = /^git-(push|send-pack|http-push)(?:\.exe)?$/.exec(baseName(w).replace(/[\\^`]/g, ''));
    return m && (i === 0 || /[\\/]/.test(w)) ? ['git', m[1]!] : [w];
  });
}

/** The Git invocation at `words[at]`, or null when that word is not `git`. */
function gitCall(words: readonly string[], at: number): GitCall | null {
  if (!isGitProgram(words[at] ?? '')) return null;
  const call: GitCall = { at, sub: -1, end: words.length, configs: [], chdir: [], elsewhere: false };
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') break;
    if (!w.startsWith('-')) {
      call.sub = i;
      break;
    }
    if (w === '-c') call.configs.push(words[++i] ?? '');
    else if (w === '-C') {
      const dir = words[++i] ?? '';
      if (!insideWorkingFolder(dir) || UNREADABLE_PATH.test(dir)) call.elsewhere = true;
      else call.chdir.push(dir);
    } else if (/^--config-env(?:=|$)/.test(w)) {
      const value = (w.includes('=') ? w.slice(w.indexOf('=') + 1) : words[++i]) ?? '';
      call.configs.push(`${value.split('=')[0]}=`);
    } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(w)) {
      call.elsewhere = true;
      if (!w.includes('=')) i++;
    } else if (/^--(?:namespace|super-prefix|attr-source)$/.test(w)) i++;
    // Every other global option takes no separate value (`--no-pager`, `-p`, `--bare`, `--exec-path[=…]`).
  }
  return call;
}

/** Every Git invocation among a command's words (`xargs git push`, `find … -exec git …` too), each word read once. */
function gitCalls(words: readonly string[]): GitCall[] {
  const calls: GitCall[] = [];
  for (let i = 0; i < words.length; i++) {
    const call = gitCall(words, i);
    if (!call) continue;
    const previous = calls.at(-1);
    if (previous) previous.end = call.at;
    calls.push(call);
    if (call.sub < 0) break;
    i = call.sub;
  }
  return calls;
}

/**
 * Shell syntax before a command that runs it: POSIX `then`, `do`, `else`,
 * `if`, `!`, `{`, `(`, and PowerShell's `if (…) {`, `foreach (…) {`,
 * `try {`, `& {`.
 */
const LEADING_SYNTAX =
  /^(?:(?:if|elseif|while|foreach|for|switch)\s*\((?:[^()]|\([^()]*\))*\)\s*\{|(?:else|try|finally|do)\s*\{|[&.]\s*\{|(?:then|do|else|elif|if|while|until|time|coproc)(?=\s)|[!{(])\s*/i;

function withoutLeadingSyntax(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 8; i++) {
    const next = t.replace(LEADING_SYNTAX, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * The branch checked out, as a push destination is often written:
 * `$(git branch --show-current)`, `` `git rev-parse --abbrev-ref HEAD` ``,
 * PowerShell's `(git symbolic-ref --short HEAD)`. Read as `HEAD`.
 */
const CURRENT_BRANCH = /(?:\$\(|\(|`)\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+(?:-q\s+)?--short\s+(?:-q\s+)?HEAD)\s*[)`]/gi;

/**
 * The commands a line runs inside `$(…)`, `<(…)`, `>(…)` and backticks, and
 * PowerShell's grouping expression given as an argument or value (`Write-Output
 * (git push origin main)`, `[void](…)`, `@(…)`, `$x = (…)`; not inside quotes,
 * where it is text), which run for the command that holds them, and that
 * command with each of them replaced by `$_` (a value only known when it runs).
 */
function substitutions(text: string): { bodies: string[]; rest: string } {
  const bodies: string[] = [];
  let rest = '';
  let quote: string | null = null;
  const group = (i: number, open: number) => {
    let depth = 1;
    let j = i + open;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    bodies.push(text.slice(i + open, depth === 0 ? j - 1 : j));
    rest += '$_';
    return j - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) {
        rest += text.slice(i);
        break;
      }
      bodies.push(text.slice(i + 1, end));
      rest += '$_';
      i = end;
    } else if ((ch === '$' || ch === '<' || ch === '>') && text[i + 1] === '(') i = group(i, 2);
    else if (ch === '(' && quote === null && i > 0 && /[\s@\],=]/.test(text[i - 1]!)) i = group(i, 1);
    else {
      if (quote === null && (ch === '"' || ch === "'")) quote = ch;
      else if (ch === quote) quote = null;
      rest += ch;
    }
  }
  return { bodies, rest };
}

/** Programs that run code given to them as a string. */
const CODE_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl', 'python', 'python3', 'py', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'eval', 'iex', 'invoke-expression', 'watch']);

/** The words of text read with every quote, escape and bracket dropped: for code whose quoting cannot be followed. */
function flatWords(text: string): string[] {
  return shellWords(text.replace(/["'`\\(),;{}]/g, ' '));
}

/** A command a line runs, as `forEachCommand` finds it. */
interface CommandSite {
  /** Its words once leading assignments, wrappers (`env`, `timeout 60`, `xargs`…) and shell syntax are removed. */
  words: string[];
  /** A wrapper appends words only known when it runs (`xargs`, `parallel`). */
  appended: boolean;
  /** It runs somewhere else, or with Git pointed elsewhere: `env -C dir`, `GIT_DIR=…`, `GIT_CONFIG_*=…`. */
  elsewhere: boolean;
  /** The segment as it was written. */
  text: string;
}

/**
 * Every command a line runs, in the order the shell runs them: segments split
 * as `splitCommands` splits them, nested interpreters unwrapped (`bash -lc
 * "…"`, `cmd /c`, `pwsh -c`, behind a wrapper too), command substitutions
 * before the command holding them, and shell syntax before a command removed.
 * Depth-limited like `analyse`: past the limit a segment's words are read with
 * every quote dropped and nothing about them trusted, so a push nested that
 * deep still counts (as one whose destination cannot be read).
 */
function forEachCommand(text: string, visit: (site: CommandSite) => void, depth = 0, inherited = { appended: false, elsewhere: false }): void {
  const segments = splitCommands(text);
  const feedsRunner = pipesIntoRunner(segments);
  segments.forEach((segment, index) => {
    if (depth >= 4) {
      visit({ words: flatWords(segment.text), appended: true, elsewhere: true, text: segment.text });
      return;
    }
    const t = withoutLeadingSyntax(segment.text.replace(CURRENT_BRANCH, 'HEAD'));
    const inner = unwrapInterpreter(t);
    if (inner !== null) {
      forEachCommand(inner, visit, depth + 1, inherited);
      return;
    }
    const { bodies, rest } = substitutions(t);
    for (const body of bodies) forEachCommand(body, visit, depth + 1, inherited);
    const all = shellWords(rest);
    if (all[0] === '&') all.shift();
    // The end of a block or group: `{ git push origin main }`, `(git push origin main)`.
    while (all.length && /^[)}]+$/.test(all.at(-1)!)) all.pop();
    if (all.length) all[all.length - 1] = all.at(-1)!.replace(/[)}]+$/, '');
    const program = withoutWrappers(all);
    const wrappers = all.slice(0, all.length - program.length);
    const words = withGitPrograms(program);
    const flags = {
      appended: inherited.appended || wrappers.some((w) => /^(?:xargs|parallel)$/i.test(baseName(w).replace(/\.exe$/i, ''))),
      // `HOME=…` and `XDG_CONFIG_HOME=…` move the user's Git config, where an alias or push setting may wait.
      elsewhere: inherited.elsewhere || wrappers.some((w) => /^(?:-C|--chdir(?:=.*)?)$/.test(w) || /^(?:GIT_(?:DIR|WORK_TREE|NAMESPACE|CONFIG\w*)|HOME|XDG_CONFIG_HOME)=/i.test(w)),
    };
    // A wrapper can run an interpreter (`timeout 60 bash -c "…"`): what that runs is a line of its own.
    const unwrapped = wrappers.length ? words.map(quoteWord).join(' ') : '';
    if (unwrapped && unwrapInterpreter(unwrapped) !== null) {
      forEachCommand(unwrapped, visit, depth + 1, flags);
      return;
    }
    // What PowerShell's Start-Process starts is a line of its own (`Start-Process git -ArgumentList 'push','origin','main'`).
    const started = startedProcess(words);
    if (started) {
      forEachCommand(started.line, visit, depth + 1, { ...flags, elsewhere: flags.elsewhere || started.elsewhere });
      return;
    }
    // Code handed to an interpreter as a string (`python -c "…os.system('git push origin main')"`,
    // `node -e "…execSync('gh pr merge 1')"`, a nested `pwsh -c` whose quoting did not unwrap): its words
    // count too, read with quotes and brackets dropped, and what they push is not trusted. So does text a
    // line writes into an interpreter's input (`echo "git push origin main" | bash`, `'…' | iex`), and
    // text a command built from its own output runs (`$(echo 'git push origin main')`).
    const code = (w: string) => visit({ words: flatWords(w), appended: true, elsewhere: false, text: w });
    const first = words[0] ?? '';
    const runsCode = CODE_RUNNERS.has(commandWord(first)) || /^[$`(%]/.test(first);
    for (const w of runsCode ? words.slice(1) : feedsRunner[index] ? words : []) if (/\s/.test(w)) code(w);
    if (runsCode) for (const body of bodies) for (const w of shellWords(body)) if (/\s/.test(w)) code(w);
    // Git runs code it is given as a setting (`-c core.pager='sh -c "…"'`, `-c alias.x='!…'`) or with `submodule foreach '…'`.
    for (const call of gitCalls(words)) {
      for (const kv of call.configs) if (/\s/.test(kv)) code(kv);
      if (words[call.sub]?.toLowerCase() === 'submodule') for (const w of words.slice(call.sub + 1, call.end)) if (/\s/.test(w)) code(w);
    }
    visit({ words, ...flags, text: t });
  });
}

/** Start-Process's parameters that take no value, and the ones that take one. */
const START_PROCESS_SWITCHES = ['wait', 'nonewwindow', 'passthru', 'loaduserprofile', 'usenewenvironment'];
const START_PROCESS_VALUES = ['argumentlist', 'filepath', 'workingdirectory', 'windowstyle', 'verb', 'credential', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'environment'];
const START_PROCESS_ALIASES: Readonly<Record<string, string>> = { args: 'argumentlist', path: 'filepath', pspath: 'filepath', lp: 'filepath' };

/**
 * The command line PowerShell's `Start-Process` (`saps`, `start`) starts: its
 * `-FilePath` (or first operand) with each `-ArgumentList` value (or later
 * operand) split at commas and spaces, as the process receives them —
 * `Start-Process git -ArgumentList 'push','origin','main'` runs `git push
 * origin main`. `elsewhere` when it runs in another folder
 * (`-WorkingDirectory`) or takes a parameter this does not know. Null for any
 * other command, or one with nothing to start.
 */
function startedProcess(words: readonly string[]): { line: string; elsewhere: boolean } | null {
  if (!/^(?:start-process|saps|start)$/.test(commandWord(words[0] ?? ''))) return null;
  const known = [...START_PROCESS_SWITCHES, ...START_PROCESS_VALUES];
  let file: string | undefined;
  const args: string[] = [];
  let elsewhere = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const m = /^-([a-z]+)(?::(.*))?$/i.exec(w);
    if (!m) {
      if (file === undefined) file = w;
      else args.push(w);
      continue;
    }
    // PowerShell takes any unambiguous prefix of a parameter's name.
    const given = m[1]!.toLowerCase();
    const prefixed = known.filter((p) => p.startsWith(given));
    const name = START_PROCESS_ALIASES[given] ?? (known.includes(given) ? given : prefixed.length === 1 ? prefixed[0] : undefined);
    if (name && START_PROCESS_SWITCHES.includes(name)) continue;
    const value = m[2] !== undefined && m[2] !== '' ? m[2] : words[++i];
    if (name === 'filepath') file = value;
    else if (name === 'argumentlist') args.push(value ?? '');
    else if (name === undefined || name === 'workingdirectory') elsewhere = true;
  }
  if (file === undefined) return null;
  const split = args.flatMap((a) => a.replace(/^@\(|\)$/g, '').split(/[\s,]+/)).filter(Boolean);
  return { line: [file, ...split].map(quoteWord).join(' '), elsewhere };
}

/** For each segment, whether a later command of its pipeline runs what it reads (`… | bash`, `… | sh -s`, `… | iex`, `… | xargs sh -c`). */
function pipesIntoRunner(segments: readonly Segment[]): boolean[] {
  const feeds = segments.map(() => false);
  for (let i = segments.length - 2; i >= 0; i--) {
    const next = segments[i + 1]!;
    if (next.joinedBy !== '|') continue;
    const words = withoutWrappers(shellWords(withoutLeadingSyntax(next.text)));
    feeds[i] = feeds[i + 1]! || CODE_RUNNERS.has(commandWord(words[0] ?? ''));
  }
  return feeds;
}

/** Settings that decide where a push without a refspec goes. */
const PUSH_CONFIG_KEY = /^(?:remote\..+\.(?:push|mirror)|push\.default|branch\..+\.merge)$/i;
/**
 * A destination only known when the line runs, or one a shell rewrites
 * before Git reads it: a variable, a substitution, a glob, `%VAR%`, `@{-1}`,
 * cmd's `^` escape (`ma^in` is `main`), a backslash escape (`ma\in` in bash),
 * a history designator (`!^`, `!:1`). Git's branch names hold none of `^ \ ?
 * * [`, so no real branch is misread as unknown.
 */
const UNREADABLE_REF = /[$`?[{%(<^!\\]|^@\w/;
/** A folder only known when the line runs (`cd $dir`, `git -C "$(…)"`, `cd %D%`), or a glob. */
const UNREADABLE_PATH = /[$`?*[{%(<]/;
/** A subcommand only known when the line runs, or one a shell rewrites first: `git $c`, `git "$(…)"`, `git @args`, `git pu\sh`, `git pu^sh`. */
const UNREADABLE_WORD = /[$`(){}@\\^%!*?[<>]/;
/** A segment that edits Git's own files or points Git elsewhere through the environment. */
const TOUCHES_GIT_STATE = /\bGIT_(?:DIR|WORK_TREE|NAMESPACE|CONFIG\w*)\b|(?:^|[\s"'=\\/])\.git(?:config\b|[\\/])/i;

/**
 * Git's own commands. An alias never hides one of them, so any other
 * subcommand (`git p origin main`) may be an alias of `push` that the
 * repository's or the user's config defines.
 */
const GIT_BUILTINS = new Set(
  (
    'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout ' +
    'checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential credential-cache ' +
    'credential-store daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack ' +
    'filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsmonitor--daemon gc get-tar-commit-id gitk grep gui hash-object help hook ' +
    'http-backend http-fetch imap-send index-pack init instaweb interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit ' +
    'maintenance merge merge-base merge-file merge-index merge-one-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 ' +
    'pack-objects pack-redundant pack-refs patch-id prune prune-packed pull range-diff read-tree rebase receive-pack reflog refs remote repack replace ' +
    'replay repo request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email sh-i18n sh-setup shortlog show show-branch show-index ' +
    'show-ref sparse-checkout stage stash status stripspace submodule svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref ' +
    'update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree'
  ).split(' '),
);

/**
 * The branch `git checkout|switch` moves to: its name; null when it cannot be
 * read (`-`, `@{-1}`, a variable) or an upstream is set with it (`--track`, a
 * new branch from `origin/main`), which a push without a refspec may follow;
 * undefined when no branch changes (`git checkout -- file`, `--detach`).
 */
function switchesTo(words: readonly string[], call: GitCall): string | null | undefined {
  let created: string | undefined;
  let tracks = false;
  const operands: string[] = [];
  for (let i = call.sub + 1; i < call.end; i++) {
    const w = words[i]!;
    if (w === '--') {
      if (created === undefined) return undefined;
      break;
    }
    if (/^(?:-[bBcC]|--orphan)$/.test(w)) created = i + 1 < call.end ? words[++i]! : '';
    else if (/^(?:-t|--track(?:=.*)?)$/.test(w)) tracks = true;
    else if (/^(?:-d|--detach)$/.test(w)) return undefined;
    else if (/^--(?:conflict|pathspec-from-file)$/.test(w)) i++;
    else if (!w.startsWith('-') || w === '-') operands.push(w);
  }
  const target = created ?? operands[0];
  if (target === undefined) return undefined;
  if (target === '-' || target.startsWith('@{') || UNREADABLE_REF.test(target) || target.includes('*')) return null;
  if (tracks || (created !== undefined && operands.some((o) => o.includes('/')))) return null;
  return target.replace(/^refs\/heads\//i, '');
}

/**
 * The key `git config` writes (`push.default`, `alias.p`; Git 2.46's `git
 * config set|unset <key>` too), 'edit' when it opens a config file in an
 * editor, or null when it only reads.
 */
function configWrite(words: readonly string[], call: GitCall): string | null {
  const operands: string[] = [];
  let writes = false;
  for (let i = call.sub + 1; i < call.end; i++) {
    const w = words[i]!;
    if (/^(?:--get(?:-all|-regexp|-urlmatch|-color|colorbool)?|--list|-l)$/.test(w)) return null;
    if (/^(?:-e|--edit)$/.test(w)) return 'edit';
    if (/^(?:-f|--file|--blob|--type|--default|--comment|--value)$/.test(w)) i++;
    else if (/^--(?:unset(?:-all)?|replace-all|add)$/.test(w)) writes = true;
    else if (!w.startsWith('-')) operands.push(w);
  }
  if (/^(?:get|list)$/.test(operands[0] ?? '')) return null;
  if (operands[0] === 'edit') return 'edit';
  if (/^(?:set|unset)$/.test(operands[0] ?? '')) {
    operands.shift();
    writes = true;
  }
  return writes || operands.length >= 2 ? (operands[0] ?? null) : null;
}

/** `base` and `parts` joined as one folder below the working folder, `/`-separated ('' for the working folder itself). */
function joinDir(base: string, ...parts: string[]): string {
  return [base, ...parts]
    .join('/')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.')
    .join('/');
}

/**
 * Where `cd`, `pushd`, `Set-Location` (…) moves the shell: a folder below the
 * working folder, 'leave' for anywhere else (`cd ..`, `cd ~`, a bare `cd`,
 * `cd -`) or a folder only known when it runs, null when the words change no
 * directory.
 */
function directoryChange(words: readonly string[]): { to: string } | 'leave' | null {
  if (!CHANGES_DIRECTORY.has(commandWord(words[0] ?? ''))) return null;
  const args = words.slice(1);
  const flagged = args.findIndex((w) => /^-(?:path|literalpath)$/i.test(w));
  const target = flagged >= 0 ? args[flagged + 1] : args.find((w) => !w.startsWith('-') || w === '-');
  return !target || !insideWorkingFolder(target) || UNREADABLE_PATH.test(target) ? 'leave' : { to: target };
}

/** The name a shell alias of Git gets (`alias g=git`, `alias g='git push'`, PowerShell's `Set-Alias g git`, `New-Alias -Name g -Value git.exe`), or null. */
function gitAliasDefined(words: readonly string[]): string | null {
  const program = commandWord(words[0] ?? '');
  const isGit = (value: string | undefined) => /^git(?:\.exe)?$/i.test(baseName(shellWords(value ?? '')[0] ?? ''));
  if (program === 'alias') {
    for (const w of words.slice(1)) {
      const eq = w.indexOf('=');
      if (eq > 0 && isGit(w.slice(eq + 1))) return w.slice(0, eq).toLowerCase();
    }
    return null;
  }
  if (!/^(?:set-alias|sal|new-alias|nal)$/.test(program)) return null;
  let name: string | undefined;
  let value: string | undefined;
  const positional: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^-name$/i.test(w)) name = words[++i];
    else if (/^-value$/i.test(w)) value = words[++i];
    else if (/^-(?:scope|option|description)$/i.test(w)) i++;
    else if (!w.startsWith('-')) positional.push(w);
  }
  name ??= positional.shift();
  value ??= positional.shift();
  return name && isGit(value) ? name.toLowerCase() : null;
}

/** What earlier commands of a line leave for a later push: branches checked out, folders moved to, aliases defined, and whether HEAD, the repository or the push settings can still be read. */
interface LineState {
  switched: string[];
  unreadable: boolean;
  /**
   * Every folder below the working folder the shell may be in by now
   * (`/`-separated, '' for the working folder itself). A `cd` adds to them and
   * never replaces one: a group (`(cd a && …)`) or a failed `cd` leaves the
   * shell where it was.
   */
  dirs: Set<string>;
  /** Git aliases the line defined (`git config alias.p push`), lowercased; `*` when it may have defined any (`git config -e`, an include, an edit of `.git/config`). */
  aliases: Set<string>;
  /** Names the line made shell aliases of Git (`alias g=git`, `Set-Alias g git`). */
  gitNames: Set<string>;
}

function newLineState(): LineState {
  return { switched: [], unreadable: false, dirs: new Set(['']), aliases: new Set(), gitNames: new Set() };
}

function noteLineState(site: CommandSite, state: LineState): void {
  const { words } = site;
  if (site.elsewhere) state.unreadable = true;
  if (TOUCHES_GIT_STATE.test(site.text)) {
    state.unreadable = true;
    state.aliases.add('*');
  }
  const move = directoryChange(words);
  if (move === 'leave') state.unreadable = true;
  else if (move) {
    for (const dir of [...state.dirs]) {
      if (state.dirs.size > 16) break;
      state.dirs.add(joinDir(dir, move.to));
    }
    // Too many folders to follow: where a push of HEAD runs cannot be read.
    if (state.dirs.size > 16) state.unreadable = true;
  }
  const named = gitAliasDefined(words);
  if (named) state.gitNames.add(named);
  for (const call of gitCalls(words)) {
    const sub = words[call.sub]?.toLowerCase();
    if (call.elsewhere) state.unreadable = true;
    const args = words.slice(call.sub + 1, call.end);
    if (sub === 'checkout' || sub === 'switch') {
      const to = switchesTo(words, call);
      if (to === null) state.unreadable = true;
      else if (to !== undefined) state.switched.push(to);
    } else if (sub === 'config') {
      const key = configWrite(words, call);
      if (key === 'edit' || (key && /^include(?:if\..+)?\.path$/i.test(key))) {
        state.unreadable = true;
        state.aliases.add('*');
      } else if (key && PUSH_CONFIG_KEY.test(key)) state.unreadable = true;
      else if (key && /^alias\./i.test(key)) state.aliases.add(key.slice('alias.'.length).toLowerCase());
    } else if (sub === 'branch') {
      if (args.some((w) => /^(?:-u|-t|--track(?:=.*)?|--set-upstream-to(?:=.*)?)$/.test(w))) state.unreadable = true;
      // `git branch -m|-M [<old>] <new>` renames the branch checked out, or one HEAD may be on: HEAD follows it to <new>.
      if (args.some((w) => /^-[a-z]*m/i.test(w) || /^--mov?e?$/.test(w))) switchTo(state, args.filter((w) => !w.startsWith('-')).at(-1));
    } else if (sub === 'stash' && args[0] === 'branch') switchTo(state, args[1]);
    else if (sub === 'symbolic-ref') {
      const operands = args.filter((w) => !w.startsWith('-'));
      if (operands.length >= 2) state.switched.push(operands[1]!.replace(/^refs\/heads\//i, ''));
    }
  }
  // `gh pr checkout` (`gh co`) checks out a pull request's head branch, named only on GitHub, with an upstream a push may follow.
  for (const args of ghCalls(words)) if ((args[0] === 'pr' && (args[1] === 'checkout' || args[1] === 'co')) || args[0] === 'co') state.unreadable = true;
}

/** HEAD is now on branch `name`: a push of HEAD goes there; one only known when it runs cannot be read. */
function switchTo(state: LineState, name: string | undefined): void {
  if (name === undefined) return;
  if (UNREADABLE_REF.test(name) || name.includes('*')) state.unreadable = true;
  else state.switched.push(name.replace(/^refs\/heads\//i, ''));
}

/** The folders, below the working folder, a Git invocation may run in: each one the shell may be in, moved by its `-C`s. */
function callDirs(state: LineState, call: GitCall): string[] {
  return [...new Set([...state.dirs].map((dir) => joinDir(dir, ...call.chdir)))];
}

/**
 * Where the `git push` commands of a line send branches (SEC-1), for callers
 * that know which branch deploys a repository. `branches` are the
 * destinations named (`main`, `HEAD:main`, `topic:refs/heads/main` → `main`),
 * with any branch the line checked out (or renamed HEAD's branch to) before
 * a push of HEAD, and the branches a `gh api` write or `gh repo sync -b`
 * names (`PATCH …/git/refs/heads/main`, a file written with `branch=main`);
 * `current` means a push of the branch checked
 * out (no refspec, or `HEAD`) in the working folder and, when `dirs` is set,
 * in those folders below it too (`cd web && git push`, `git -C web push`);
 * `every` means `--all`, `--branches`, `--mirror`, `:` or a wildcard refspec;
 * `unknown` means a push whose destination is only known when the line runs —
 * a variable or substitution (`git push origin $b`), a remote that may bring
 * refspecs of its own (`git push @b`, `git push $r main`), a subcommand only
 * known then (`git $c`, `git @args`), `send-pack`, `subtree push`, an alias the line
 * defines (`-c alias.p=push`), a push run by another command (`xargs git
 * push`, `find … -exec git push`), text fed to an interpreter (`echo "git push
 * …" | bash`), a `gh api` write to a branch it does not name (a file on the
 * default branch, GraphQL `createCommitOnBranch`) or `gh repo sync <repo>`
 * without `-b`, an option Git reads differently or not at all, or a push of
 * HEAD after the line left the working folder, checked out `-` or a pull
 * request (`gh pr checkout`), or changed where a push goes (`git config
 * push.default`, `-c remote.origin.push=…`, `GIT_DIR=…`). `aliases` are
 * subcommands that are not Git's own, with the folders they run in: the
 * caller looks them up in the repository's config (`gitAliasPushes`). A dry
 * run (`-n`, not undone by `--no-dry-run`) pushes nothing. A line continued
 * with `\`, a backtick or `^` at the end of a line is read both joined and
 * not. Null when the line has no push and no such subcommand.
 *
 * `before` is what ran earlier in the same shell (the lines an agent typed
 * into a terminal): its checkouts, folders and settings hold, its pushes are
 * not counted again.
 */
export interface GitPushTargets {
  branches: string[];
  current: boolean;
  every: boolean;
  unknown: boolean;
  dirs?: string[];
  aliases?: Array<{ name: string; dirs: string[] }>;
}

export function gitPushTargets(command: string, before = ''): GitPushTargets | null {
  const out: GitPushTargets = { branches: [], current: false, every: false, unknown: false };
  let found = readPushes(command, before, out);
  const joined = (text: string) => text.replace(/[\\`^]\r?\n/g, '');
  if (joined(command) !== command || joined(before) !== before) found = readPushes(joined(command), joined(before), out) || found;
  if (!found) return null;
  out.branches = [...new Set(out.branches)];
  if (out.dirs) out.dirs = [...new Set(out.dirs)];
  // Each alias once per set of folders: the caller looks each one up in Git's config.
  if (out.aliases) out.aliases = [...new Map(out.aliases.map((a) => [`${a.name}\0${a.dirs.join('\0')}`, a])).values()];
  return out;
}

/**
 * `push`, `send-pack` or `http-push` as a word of its own — not `pushd`,
 * `Push-Location`, `services/push` or `pusher.py` — or a Git program that
 * pushes (`git-push`, `…/git-core/git-send-pack`).
 */
const PUSH_WORD = /(?<=^|[\s"'`=;,|&(){}[\]])(?:push|send-pack|http-push)(?=$|[\s"'`;,|&(){}[\]])|(?<=^|[\s"'`=;,|&(){}[\]\\/])git-(?:push|send-pack|http-push)(?:\.exe)?(?=$|[\s"'`;,|&(){}[\]])/i;
/** Git, or a push, as a word of a value. */
const GIT_OR_PUSH_WORD = /(?<=^|[\s"'`=,(])(?:git(?:\.exe)?|push|send-pack|http-push)(?=$|[\s"'`;,|&)])/i;
/**
 * Where a variable is given a value: a POSIX `x=` (group 1: its value is one
 * word, so `HUSKY=0 git push` gives `0`), or PowerShell's `$x = `/`$env:X=`,
 * cmd's `set X=` and `Set-Variable x `, whose value runs to the end of the
 * command.
 */
const ASSIGNMENT = /(?<=^|[\s;&|({])(?:([a-z_]\w*=)|\$(?:env:)?[a-z_]\w*\s*=(?!=)|(?:set-variable|new-variable|sv|nv|set)\s+)/gim;
/** A one-word value, and a value to the end of its command: quoted runs whole. */
const WORD_VALUE = /(?:"[^"\n]*"?|'[^'\n]*'?|[^\s;&|"'])*/y;
const COMMAND_VALUE = /(?:"[^"\n]*"?|'[^'\n]*'?|[^\n;&|"'])*/y;

/** The text gives a variable a value that names Git or a push, which a later `$x` may run. */
function assignsGitOrPush(text: string): boolean {
  if (!text || !/git|push|send-pack/i.test(text)) return false;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const reader = m[1] ? WORD_VALUE : COMMAND_VALUE;
    reader.lastIndex = m.index + m[0].length;
    const value = reader.exec(text)?.[0] ?? '';
    if (GIT_OR_PUSH_WORD.test(value)) return true;
    // Values never overlap: each character is read once.
    ASSIGNMENT.lastIndex = Math.max(ASSIGNMENT.lastIndex, m.index + m[0].length + value.length);
  }
  return false;
}

/**
 * The branch `gh repo sync <repository>` writes on GitHub (`-b`, or else the
 * default branch): it syncs that repository's branch from its parent. Without
 * a repository it syncs the local one, which pushes nothing.
 */
function repoSyncWrites(args: readonly string[]): { branches: string[]; unknown: boolean } | null {
  let repository: string | undefined;
  let branch: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^(?:-b|--branch)(?:=(.*))?$/.exec(w))) branch = m[1] ?? args[++i];
    else if (/^(?:-s|--source)$/.test(w)) i++;
    else if (!w.startsWith('-') && repository === undefined) repository = w;
  }
  if (repository === undefined) return null;
  return branch && !UNREADABLE_REF.test(branch) ? { branches: [branch.replace(/^refs\/heads\//i, '')], unknown: false } : { branches: [], unknown: true };
}

function readPushes(command: string, before: string, out: GitPushTargets): boolean {
  const state = newLineState();
  // Earlier lines read as one text (a quote or `\` continued across them) and one by one (a `#` comment's quote ends at its line):
  // what each reading leaves holds.
  if (before) forEachCommand(before, (site) => noteLineState(site, state));
  if (before.includes('\n')) for (const line of before.split('\n')) forEachCommand(line, (site) => noteLineState(site, state));
  let found = false;
  // A line that says `push` (`x="git push origin main"; $x`, `bash -c "$CMD" # push`) or gives a variable a value
  // naming Git (`x="git pu"; y="sh origin main"; $x$y`), or an earlier line that gave one such a value.
  const saysPush = PUSH_WORD.test(command) || assignsGitOrPush(command) || assignsGitOrPush(before);
  forEachCommand(command, (site) => {
    const { words } = site;
    // A program only known when it runs, or a shell alias of Git, given `push` (`$GIT push origin main`, `& $git push`,
    // `%G% push`, `& (Get-Command git) push`, `g push` after `alias g=git`); or a command only known when it runs,
    // or code in a variable handed to an interpreter, on a line that says `push` (`$cmd`, `eval "$cmd"`, `iex $cmd`).
    const program = words[0] ?? '';
    const unreadable = !gitCall(words, 0) && /[$`%]|^\(/.test(program);
    const pushWord = words.slice(1).some((w) => /^(?:push|send-pack|http-push)$/i.test(w));
    const runsVariable = CODE_RUNNERS.has(commandWord(program)) && words.slice(1).some((w) => /[$`%]/.test(w));
    if (((unreadable || state.gitNames.has(commandWord(program))) && pushWord) || (saysPush && (unreadable || runsVariable))) {
      found = true;
      out.unknown = true;
    }
    for (const call of gitCalls(words)) {
      const runs = gitRuns(words, call, site, state);
      if (!runs) continue;
      found = true;
      if (runs === 'unknown') out.unknown = true;
      else if (runs === 'alias') (out.aliases ??= []).push({ name: words[call.sub]!.toLowerCase(), dirs: callDirs(state, call) });
      else {
        // Run by another command (`find … -exec git push`, `watch git push`, `sudo git push`): what it is handed is not on the line.
        if (call.at > 0) out.unknown = true;
        notePush(site, call, state, out);
      }
    }
    for (const args of ghCalls(words)) {
      const writes = args[0] === 'api' ? apiBranchWrites(ghApiCall(args.slice(1))) : args[0] === 'repo' && args[1] === 'sync' ? repoSyncWrites(args.slice(2)) : null;
      if (!writes) continue;
      found = true;
      out.branches.push(...writes.branches);
      if (writes.unknown) out.unknown = true;
    }
    noteLineState(site, state);
  });
  return found;
}

/**
 * The lines a shell ran, for judging a later line after them (a terminal's
 * history): the last `max`, and before them each older line that moved to
 * another folder, made a shell alias of Git or gave a variable a value naming
 * Git (`cd web`, `alias g=git`, `x="git push origin main"`) — the shell still
 * holds that, and no file does. When those are more than `max` too, `cd -`
 * stands in for the ones dropped, so a later push of HEAD is read as unknown.
 */
export function shellHistory(lines: readonly string[], max = 50): string[] {
  if (lines.length <= max) return [...lines];
  const holdsState = (line: string) => {
    if (assignsGitOrPush(line)) return true;
    let holds = false;
    forEachCommand(line, ({ words }) => {
      if (directoryChange(words) || gitAliasDefined(words)) holds = true;
    });
    return holds;
  };
  const held = lines.slice(0, -max).filter(holdsState);
  return [...(held.length > max ? ['cd -', ...held.slice(-max)] : held), ...lines.slice(-max)];
}

/**
 * What a Git invocation means to the release gate: 'push'; 'unknown' for one
 * that may push where the line cannot say (a subcommand only known when it
 * runs, `send-pack`, `http-push`, `subtree push`, an alias the line defines or
 * may define); 'alias' for another subcommand that is not Git's own; null
 * otherwise.
 */
function gitRuns(words: readonly string[], call: GitCall, site: CommandSite, state: LineState): 'push' | 'unknown' | 'alias' | null {
  const word = words[call.sub];
  if (word === undefined) return null;
  const sub = word.toLowerCase();
  if (sub === 'push') return 'push';
  if (UNREADABLE_WORD.test(word) || sub === 'send-pack' || sub === 'http-push') return 'unknown';
  if (sub === 'subtree') return words.slice(call.sub + 1, call.end).includes('push') ? 'unknown' : null;
  if (GIT_BUILTINS.has(sub)) return null;
  const defined = call.configs.some((kv) => kv.split('=')[0]!.toLowerCase() === `alias.${sub}`) || state.aliases.has(sub) || state.aliases.has('*');
  return defined || call.elsewhere || site.elsewhere ? 'unknown' : 'alias';
}

/**
 * `git push`'s long options (Git 2.43 on) and whether each takes a value
 * as the next word; `optional` ones take one only as `--x=value`. Git accepts
 * any unambiguous prefix (`--al` is `--all`) and `--no-` before each.
 */
const PUSH_OPTIONS: Readonly<Record<string, 'flag' | 'value' | 'optional'>> = {
  verbose: 'flag',
  quiet: 'flag',
  repo: 'value',
  all: 'flag',
  branches: 'flag',
  mirror: 'flag',
  delete: 'flag',
  tags: 'flag',
  'dry-run': 'flag',
  porcelain: 'flag',
  force: 'flag',
  'force-with-lease': 'optional',
  'force-if-includes': 'flag',
  'recurse-submodules': 'value',
  thin: 'flag',
  'receive-pack': 'value',
  exec: 'value',
  'set-upstream': 'flag',
  progress: 'flag',
  prune: 'flag',
  'no-verify': 'flag',
  verify: 'flag',
  'follow-tags': 'flag',
  signed: 'optional',
  atomic: 'flag',
  'push-option': 'value',
  ipv4: 'flag',
  ipv6: 'flag',
};

/** A `git push` long option (without its `--`) as Git reads it: exact, `no-` negated, or a unique prefix of either; null when Git would refuse it as unknown or ambiguous. */
function pushLongOption(text: string): { name: string; negated: boolean; value?: string } | null {
  const eq = text.indexOf('=');
  const key = eq < 0 ? text : text.slice(0, eq);
  const value = eq < 0 ? undefined : text.slice(eq + 1);
  if (!key) return null;
  const forms = Object.keys(PUSH_OPTIONS).flatMap((name) => [
    { form: name, name, negated: false },
    { form: `no-${name}`, name, negated: true },
  ]);
  const exact = forms.find((f) => f.form === key);
  if (exact) return { name: exact.name, negated: exact.negated, value };
  const prefixed = forms.filter((f) => f.form.startsWith(key));
  return prefixed.length === 1 ? { name: prefixed[0]!.name, negated: prefixed[0]!.negated, value } : null;
}

function notePush(site: CommandSite, call: GitCall, state: LineState, out: GitPushTargets): void {
  const { words } = site;
  const operands: string[] = [];
  let dryRun = false;
  let tagsOnly = false;
  let every = false;
  for (let i = call.sub + 1; i < call.end; i++) {
    const w = words[i]!;
    if (w === '--') {
      operands.push(...words.slice(i + 1, call.end));
      break;
    }
    if (!w.startsWith('-') || w === '-') {
      operands.push(w);
      continue;
    }
    if (w.startsWith('--')) {
      const option = pushLongOption(w.slice(2));
      // Unknown or ambiguous: Git refuses it, or a newer Git reads it in a way this does not.
      if (!option) out.unknown = true;
      else if (option.name === 'dry-run') dryRun = !option.negated;
      else if (/^(?:all|branches|mirror)$/.test(option.name)) every ||= !option.negated;
      else if (option.name === 'tags') tagsOnly = !option.negated;
      else if (PUSH_OPTIONS[option.name] === 'value' && !option.negated && option.value === undefined) i++;
      continue;
    }
    // Short options, alone or clustered (`-nu`, `-uo ci.skip`, `-oci.skip`); the last `-n`/`--[no-]dry-run` wins.
    for (let k = 1; k < w.length; k++) {
      const c = w[k]!;
      if (c === 'n') dryRun = true;
      else if (c === 'o') {
        if (k === w.length - 1) i++;
        break;
      } else if (!'vqfdu46'.includes(c)) {
        out.unknown = true;
        break;
      }
    }
  }
  if (dryRun) return;
  if (every) out.every = true;
  if (site.appended) out.unknown = true;
  // A remote only known when the line runs can bring refspecs of its own: a splat (`sv b origin,main; git push @b`),
  // a variable the shell splits (`b="origin main"; git push $b`), a glob or a brace expansion.
  if (operands[0] !== undefined && /[$`%*?[{]|^@\w/.test(operands[0])) out.unknown = true;
  // A push of HEAD: the branch checked out where it runs, or one the line checked out first — unless where it goes can no longer be read.
  const head = () => {
    if (state.unreadable || call.elsewhere || site.elsewhere || call.configs.some((kv) => PUSH_CONFIG_KEY.test(kv.split('=')[0]!))) out.unknown = true;
    else {
      out.current = true;
      out.branches.push(...state.switched);
      const below = callDirs(state, call).filter(Boolean);
      if (below.length) (out.dirs ??= []).push(...below);
    }
  };
  const refspecs = operands.slice(1);
  if (!refspecs.length) {
    if (!every && !tagsOnly) head();
    return;
  }
  for (const spec of refspecs) {
    const plain = spec.replace(/^\+/, '');
    if (plain === ':') {
      // `git push origin :` pushes every matching branch.
      out.every = true;
      continue;
    }
    const destination = plain.includes(':') ? plain.slice(plain.indexOf(':') + 1) : plain;
    if (!destination) continue;
    if (destination.includes('*')) out.every = true;
    // A shell expansion anywhere in the refspec (`!:1` is bash's history, `$x:y`) can move where it pushes.
    else if (UNREADABLE_REF.test(destination) || destination === '-' || /[!$`]/.test(plain)) out.unknown = true;
    else if (/^(?:HEAD|@)$/i.test(destination)) head();
    else if (!/^refs\/(?!heads\/)/i.test(destination)) out.branches.push(destination.replace(/^refs\/heads\//i, ''));
  }
}

/**
 * What a Git alias runs (the value of `git config alias.<name>`), for the
 * release gate: true when it may push — `push …`, `send-pack`, `subtree
 * push`, a pull-request merge, or a `!` shell command that pushes or cannot
 * be read — false when it runs one of Git's own commands that does not, or
 * the name of the alias it calls in turn.
 */
export function gitAliasPushes(value: string): boolean | string {
  const text = value.trim();
  const shell = text.startsWith('!');
  const line = shell ? text.slice(1) : `git ${text}`;
  if (mergesPullRequest(line)) return true;
  const targets = gitPushTargets(line);
  if (!targets) return false;
  if (targets.branches.length || targets.current || targets.every || targets.unknown) return true;
  const next = targets.aliases?.[0]?.name;
  if (!next) return false;
  return shell ? true : next;
}

/** Each `gh` invocation among a command's words: its arguments up to the next `gh`, without `-R owner/repo` (`gh pr -R o/r merge 1`). */
function ghCalls(words: readonly string[]): string[][] {
  const starts = words.flatMap((w, i) => (commandWord(w) === 'gh' ? [i] : []));
  return starts.map((start, k) =>
    words.slice(start + 1, starts[k + 1] ?? words.length).filter((a, j, all) => !/^(?:-R|--repo)(?:=.*)?$/.test(a) && !/^(?:-R|--repo)$/.test(all[j - 1] ?? '')),
  );
}

/**
 * The line merges a pull request (SEC-1): `gh pr merge`, or the same through
 * `gh api` — REST `PUT …/pulls/<n>/merge` or `POST …/merges`, GraphQL
 * `mergePullRequest` or `enablePullRequestAutoMerge`. The base is not on the
 * line, and it is usually the branch a repository releases from.
 */
export function mergesPullRequest(command: string): boolean {
  let merges = false;
  forEachCommand(command, ({ words }) => {
    for (const args of ghCalls(words)) {
      if (merges) return;
      if (args[0] === 'pr' && args[1] === 'merge') merges = true;
      else if (args[0] === 'api' && apiMerges(ghApiCall(args.slice(1)))) merges = true;
    }
  });
  return merges;
}

/** A `gh api` request as its arguments give it: the method (POST when fields are sent, GET otherwise), the endpoint, the named fields, and whether the body comes from a file (`--input`). */
interface GhApiCall {
  verb: string;
  endpoint: string;
  fields: Map<string, string>;
  values: string;
  fromFile: boolean;
}

function ghApiCall(args: readonly string[]): GhApiCall | null {
  let method: string | undefined;
  let sends = false;
  let fromFile = false;
  let endpoint: string | undefined;
  let values = '';
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^(?:-X|--method)(?:=?(.+))?$/.exec(w))) method = (m[1] ?? args[++i] ?? '').toUpperCase();
    else if ((m = /^--input(?:=(.*))?$/.exec(w))) {
      sends = true;
      fromFile = true;
      values += ` ${m[1] ?? args[++i] ?? ''}`;
    } else if ((m = /^(?:-[fF]|--field|--raw-field)(?:=(.*))?$/.exec(w) ?? /^-[fF](.+)$/.exec(w))) {
      sends = true;
      const field = m[1] ?? args[++i] ?? '';
      values += ` ${field}`;
      const eq = field.indexOf('=');
      if (eq > 0) fields.set(field.slice(0, eq), field.slice(eq + 1));
      // A typed field (`-F`, `--field`) whose value starts with `@` is read from that file.
      if (/^(?:-F|--field)/.test(w) && field.slice(eq + 1).startsWith('@')) fromFile = true;
    } else if (/^(?:-H|--header|-q|--jq|-t|--template|--hostname|--cache|-p|--preview)$/.test(w)) i++;
    else if (!w.startsWith('-') && endpoint === undefined) endpoint = w.replace(/[?#].*$/, '');
  }
  return endpoint ? { verb: method ?? (sends ? 'POST' : 'GET'), endpoint, fields, values, fromFile } : null;
}

function apiMerges(api: GhApiCall | null): boolean {
  if (!api) return false;
  if (/(?:^|\/)pulls\/[^/]+\/merge\/?$/i.test(api.endpoint)) return api.verb === 'PUT';
  if (/(?:^|\/)merges\/?$/i.test(api.endpoint)) return api.verb === 'POST';
  if (api.endpoint === 'graphql') return /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(api.values);
  return false;
}

/**
 * The branches a `gh api` write moves without Git: a branch's ref updated,
 * created or deleted (`…/git/refs/heads/<b>`, `POST …/git/refs` with
 * `ref=refs/heads/<b>`), a file written or deleted (`…/contents/<path>`, on
 * `branch=<b>` or else the default branch), a branch renamed, a fork synced
 * (`…/merge-upstream`), or GraphQL `createCommitOnBranch`/`updateRef(s)`/
 * `createRef`/`deleteRef`. `unknown` when the branch is not on the line.
 */
function apiBranchWrites(api: GhApiCall | null): { branches: string[]; unknown: boolean } | null {
  if (!api || api.verb === 'GET' || api.verb === 'HEAD') return null;
  const named = (...names: Array<string | undefined>) => {
    const branches = names.filter((b): b is string => Boolean(b)).map((b) => b.replace(/^refs\/heads\//i, ''));
    const readable = branches.length > 0 && !api.fromFile && branches.every((b) => !UNREADABLE_REF.test(b));
    return { branches: readable ? branches : [], unknown: !readable };
  };
  const e = api.endpoint;
  let m: RegExpExecArray | null;
  if ((m = /(?:^|\/)git\/refs\/heads\/(.+?)\/?$/i.exec(e))) return named(m[1]);
  if (/(?:^|\/)git\/refs\/?$/i.test(e)) {
    const ref = api.fields.get('ref');
    return ref && !/^refs\/heads\//i.test(ref) && !api.fromFile ? null : named(ref);
  }
  if (/(?:^|\/)contents(?:\/|$)/i.test(e) || /(?:^|\/)merge-upstream\/?$/i.test(e)) return named(api.fields.get('branch'));
  if ((m = /(?:^|\/)branches\/(.+?)\/rename\/?$/i.exec(e))) return named(m[1], api.fields.get('new_name'));
  if (e === 'graphql') return api.fromFile || /\b(?:createCommitOnBranch|updateRefs?|createRef|deleteRef)\b/.test(api.values) ? { branches: [], unknown: true } : null;
  return null;
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = command.replace(/[ \t]+/g, ' ').trim();
  const acc: Accumulator = { risk: 'normal', level: 2, reasons: [], effects: new Set(), readOnly: normalized.length > 0 };
  analyse(normalized, acc, 0);
  // A push the Git rules do not spell out, read as the release gate reads it: `git $c origin main`,
  // `git -c alias.p=push p origin main`, `git send-pack`, `echo "git push …" | bash`, `gh api --method PATCH …/git/refs/heads/x`.
  const pushes = /git|\bgh\b|push/i.test(normalized) ? gitPushTargets(normalized) : null;
  if (pushes && (pushes.branches.length || pushes.current || pushes.every || pushes.unknown)) note(acc, 'elevated', 3, 'Pushes to a remote', ['git', 'network']);

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
