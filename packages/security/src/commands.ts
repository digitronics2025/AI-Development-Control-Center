import type { CommandRisk, PermissionLevel } from '@acc/shared';

/**
 * Command classification (PLAN §30). Every command the orchestrator itself
 * runs (repository test/build/deploy commands) is classified before launch.
 * The classification decides the permission level it needs; dangerous
 * commands always require explicit approval, whatever the nominal level.
 */

export interface CommandClassification {
  risk: CommandRisk;
  level: PermissionLevel;
  /** Human explanation of why the command landed in this class. */
  reasons: string[];
  production: boolean;
}

interface Pattern {
  test: RegExp;
  risk: CommandRisk;
  level: PermissionLevel;
  reason: string;
}

const PRODUCTION = /(?:--env(?:ironment)?[ =]+(?:prod|production)\b|\bprod(?:uction)?\b.*\b(?:deploy|migrat|release)|\b(?:deploy|migrat|release)\w*\b.*\bprod(?:uction)?\b|--remote\b.*\bprod)/i;

const PATTERNS: Pattern[] = [
  // Destructive file-system operations.
  { test: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)/i, risk: 'dangerous', level: 5, reason: 'Recursive deletion' },
  { test: /\b(?:rmdir|rd)\s+\/s\b/i, risk: 'dangerous', level: 5, reason: 'Recursive directory deletion' },
  { test: /\bdel\s+(?:\/[a-z]\s+)*\/s\b/i, risk: 'dangerous', level: 5, reason: 'Recursive file deletion' },
  { test: /\bRemove-Item\b.*-Recurse/i, risk: 'dangerous', level: 5, reason: 'Recursive deletion' },
  { test: /\b(?:format|mkfs|diskpart)\b/i, risk: 'dangerous', level: 5, reason: 'Disk formatting' },
  { test: /\bgit\s+clean\s+-[a-z]*f/i, risk: 'dangerous', level: 5, reason: 'Deletes untracked files' },
  { test: /\bgit\s+reset\s+--hard\b/i, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work' },
  { test: /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/i, risk: 'dangerous', level: 5, reason: 'Discards uncommitted work' },
  { test: /\bgit\s+push\b.*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S+)/i, risk: 'dangerous', level: 5, reason: 'Force push rewrites remote history' },
  { test: /\bgit\s+push\b.*\s--delete\b|\bgit\s+push\s+\S+\s+:\S+/i, risk: 'dangerous', level: 5, reason: 'Deletes a remote branch' },
  { test: /\bgit\s+(?:filter-branch|filter-repo)\b/i, risk: 'dangerous', level: 5, reason: 'Rewrites Git history' },
  // Destructive database operations.
  { test: /\bdrop\s+(?:table|database|schema|index|view)\b/i, risk: 'dangerous', level: 5, reason: 'Drops database objects' },
  { test: /\btruncate\s+(?:table\s+)?\w+/i, risk: 'dangerous', level: 5, reason: 'Truncates a table' },
  { test: /\bdelete\s+from\s+\w+(?![^;]*\bwhere\b)/i, risk: 'dangerous', level: 5, reason: 'Deletes every row of a table' },
  // Infrastructure destruction.
  { test: /\bterraform\s+destroy\b/i, risk: 'dangerous', level: 5, reason: 'Destroys infrastructure' },
  { test: /\bkubectl\s+delete\b/i, risk: 'dangerous', level: 5, reason: 'Deletes cluster resources' },
  { test: /\bwrangler\s+(?:\S+\s+)*(?:delete|destroy)\b/i, risk: 'dangerous', level: 5, reason: 'Deletes Cloudflare resources' },
  { test: /\b(?:npm|pnpm|yarn)\s+unpublish\b/i, risk: 'dangerous', level: 5, reason: 'Removes a published package' },
  // Elevated: leaves the machine.
  { test: /\bgit\s+push\b/i, risk: 'elevated', level: 3, reason: 'Pushes to a remote' },
  { test: /\bgh\s+(?:pr|release)\s+(?:create|merge)\b/i, risk: 'elevated', level: 3, reason: 'Changes GitHub state' },
  { test: /\b(?:npm|pnpm|yarn)\s+publish\b/i, risk: 'elevated', level: 4, reason: 'Publishes a package' },
  { test: /\bwrangler\s+(?:deploy|publish|pages\s+deploy|versions\s+deploy)\b/i, risk: 'elevated', level: 4, reason: 'Deploys to Cloudflare' },
  { test: /\bwrangler\s+d1\s+(?:migrations\s+apply|execute)\b.*--remote\b/i, risk: 'elevated', level: 4, reason: 'Changes a remote D1 database' },
  { test: /\b(?:vercel|netlify|flyctl|fly)\s+deploy\b|\bvercel\b.*--prod\b/i, risk: 'elevated', level: 4, reason: 'Deploys a site' },
  { test: /\b(?:kubectl\s+apply|helm\s+(?:install|upgrade)|terraform\s+apply)\b/i, risk: 'elevated', level: 4, reason: 'Changes infrastructure' },
  { test: /\b(?:prisma|drizzle-kit|knex|sequelize)\b.*\b(?:migrate\s+deploy|push|migrate)\b/i, risk: 'elevated', level: 4, reason: 'Applies database migrations' },
];

export function classifyCommand(command: string): CommandClassification {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const reasons: string[] = [];
  let risk: CommandRisk = 'normal';
  let level: PermissionLevel = 2;
  const rank = { normal: 0, elevated: 1, dangerous: 2 } as const;

  for (const pattern of PATTERNS) {
    if (!pattern.test.test(normalized)) continue;
    if (rank[pattern.risk] > rank[risk]) risk = pattern.risk;
    if (pattern.level > level) level = pattern.level;
    if (!reasons.includes(pattern.reason)) reasons.push(pattern.reason);
  }

  const production = PRODUCTION.test(normalized);
  if (production) {
    level = 5;
    if (risk === 'normal') risk = 'elevated';
    reasons.push('Targets production');
  }

  if (reasons.length === 0) reasons.push('Local command');
  return { risk, level, reasons, production };
}

/** True when the command needs a human decision regardless of auto-approve settings. */
export function alwaysRequiresApproval(classification: CommandClassification): boolean {
  return classification.risk === 'dangerous' || classification.level === 5;
}
