import type { ChairmanActionInput, ChatIntent, Role, StageKind } from '@acc/shared';
import { deriveRule, requiredCheckKinds } from './rules.js';

/**
 * Ask vs act (plan §3.14). Deterministic first: questions never mutate, clear
 * commands map to typed actions, and anything unrecognised is at most a
 * directive (reversible, visible). The reasoning model is consulted only for
 * sentences this parser is not confident about.
 */

export interface IntentContext {
  stages: Array<{ key: string; name: string; role: Role; kind: StageKind }>;
  agents: Array<{ id: string; name: string }>;
  directives: Array<{ id: string; text: string }>;
}

export interface ParsedMessage {
  intent: ChatIntent;
  actions: ChairmanActionInput[];
  /** Set when one short question must be answered before anything happens. */
  clarification: string | null;
  /** A reply the chat can give without the reasoning model. */
  note: string | null;
  confident: boolean;
  /** STATUS sub-topic for deterministic answers. */
  topic?: 'status' | 'blockers' | 'directives';
}

const QUESTION_START = /^(what|why|how|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|would|should|will|has|have|had|may|might|shall|any|isn't|aren't|didn't|doesn't|won't|wouldn't)\b/;
const POLITE_REQUEST = /^(?:can|could|would|will) you (?:please )?(.+)$/;
const STATUS_WORDS = /\b(status|happening|going on|progress|blocking|blocked|blocker|stuck|where are we|doing now|current stage|state of)\b/;

const STAGE_WORDS: Array<{ re: RegExp; role?: Role; kind?: StageKind }> = [
  { re: /\b(investigat\w*|root[- ]cause)\b/, role: 'investigator' },
  { re: /\b(plan|planning|planner)\b/, role: 'planner' },
  { re: /\b(implement\w*)\b/, role: 'implementer' },
  { re: /\b(review|reviewer|reviewing)\b/, role: 'reviewer' },
  { re: /\b(fix|fixer|fixing)\b/, role: 'fixer' },
  { re: /\b(verify|verification|verifier|verifying)\b/, role: 'verifier' },
  { re: /\b(test|tests|testing)\b/, kind: 'tests' },
];

function stageFrom(text: string, ctx: IntentContext): { key: string; name: string } | null {
  for (const s of ctx.stages) if (new RegExp(`\\b${s.key.replace(/-/g, '[- ]')}\\b`).test(text) || text.includes(s.name.toLowerCase())) return s;
  for (const w of STAGE_WORDS) {
    if (!w.re.test(text)) continue;
    const match = ctx.stages.find((s) => (w.role ? s.role === w.role && s.kind === 'agent' : s.kind === w.kind));
    if (match) return match;
  }
  return null;
}

function agentFrom(text: string, ctx: IntentContext): { id: string; name: string } | null {
  for (const a of ctx.agents) {
    const names = [a.id, a.name.toLowerCase(), a.name.toLowerCase().replace(/\s*\(.*\)$/, '')];
    if (names.some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))) return a;
  }
  return null;
}

function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:ok(?:ay)?|hey|chairman|please|so|now|alright)[,:!\s]+/i, '')
    .replace(/^please\s+/i, '')
    .trim();
}

const result = (intent: ChatIntent, actions: ChairmanActionInput[], extra: Partial<ParsedMessage> = {}): ParsedMessage => ({
  intent,
  actions,
  clarification: null,
  note: null,
  confident: true,
  ...extra,
});

/** Imperatives this parser understands. Returns null when the sentence is not one of them. */
function parseCommand(text: string, original: string, ctx: IntentContext): ParsedMessage | null {
  const t = text.replace(/[.!]+$/, '');

  // Routing: "use Claude for review", "switch review to Codex", "let Codex handle the fix",
  // optionally with an effort: "use Claude for review with high effort" (never silently dropped).
  const effortPhrase = /[,;]?\s*(?:(?:with|at|on|using)\s+)?(?:an?\s+)?(low|medium|high|xhigh|max|ultra)\s+effort\b|[,;]?\s*(?:with\s+)?effort\s*(?:of|=|:)?\s*(low|medium|high|xhigh|max|ultra)\b/.exec(t);
  const effort = effortPhrase ? (effortPhrase[1] ?? effortPhrase[2])! : undefined;
  const routed = effortPhrase ? t.replace(effortPhrase[0], '').trim() : t;
  const routing =
    /^(?:use|let|have|put|assign)\s+(.+?)\s+(?:for|to do|to handle|handle|do|on|to run|run)\s+(?:the\s+)?(.+)$/.exec(routed) ??
    /^(?:switch|route|move|reroute|reassign|give)\s+(?:the\s+)?(.+?)(?:\s+stage)?\s+to\s+(.+)$/.exec(routed);
  if (routing) {
    const first = /^(?:use|let|have|put|assign)/.test(routed);
    const agentText = first ? routing[1]! : routing[2]!;
    const stageText = first ? routing[2]! : routing[1]!;
    const agent = agentFrom(agentText, ctx);
    const stage = stageFrom(stageText, ctx);
    if (agent && stage) {
      return result('ROUTING_CHANGE', [
        { type: 'CHANGE_AGENT', params: { stageKey: stage.key, agentId: agent.id, ...(effort ? { effort } : {}) } },
        { type: 'ADD_DIRECTIVE', params: { text: original, kind: 'routing', scope: 'CURRENT_TASK', rule: { type: 'routing', stageKey: stage.key, agentId: agent.id } } },
      ]);
    }
    if (agent && !stage) return result('ROUTING_CHANGE', [], { clarification: `Which stage should ${agent.name} run? For example: "Use ${agent.name} for Review".` });
  }

  if (/^(pause|hold)\b/.test(t) || /^stop\b(?!.*\b(go|return|back)\b)(?!\s+(modifying|changing|touching|editing))/.test(t)) {
    const after = /\b(after|once|when)\b.*\b(current|this|the)\b.*\b(stage|step|test|tests|run|fix|review)\b|\bat the next (safe )?(point|boundary|stage)\b/.test(t);
    return result('COMMAND', [{ type: 'PAUSE_TASK', params: { when: after ? 'after_stage' : 'now' } }]);
  }
  if (/^(resume|unpause|restart the task)\b/.test(t)) return result('COMMAND', [{ type: 'RESUME_TASK', params: {} }]);
  if (/^(continue|carry on|go on|go ahead|keep going|proceed)\b/.test(t)) return result('COMMAND', [{ type: 'CONTINUE', params: {} }]);

  // A rollback discards the stage's work, so only a bare command is one: "roll back",
  // "undo that", "revert the last (bad) change/attempt/stage/checkpoint". A sentence that
  // names something else ("undo the console.log", "revert the lockfile change") is an
  // instruction to the agent, not a rollback (audit F-07).
  if (/^(?:roll ?back|revert|undo)(?:\s+(?:it|that|this|everything|all of it|(?:the\s+|your\s+|my\s+)?(?:(?:last|latest|previous|most recent)\s+)?(?:bad\s+|broken\s+|failed\s+)?(?:change|changes|attempt|fix|stage|step|edit|edits|checkpoint)))?(?:\s+(?:please|now))?$/.test(t)) {
    return result('COMMAND', [{ type: 'ROLLBACK_CHECKPOINT', params: {} }]);
  }
  if (/\b(create|make|take|save|add)\b.*\b(checkpoint|save point|restore point)\b/.test(t)) {
    return result('COMMAND', [{ type: 'CREATE_CHECKPOINT', params: {} }]);
  }

  // "Run E2E before finishing" is a requirement, not an immediate run.
  const kinds = requiredCheckKinds(t);
  const rule = deriveRule(original);
  if (rule?.type === 'require_check') {
    return result('DIRECTIVE', [{ type: 'ADD_DIRECTIVE', params: { text: original, kind: 'requirement', scope: 'CURRENT_TASK', rule } }]);
  }
  if (/^(run|rerun|re-run|execute|start)\b|^(retest|re-test)\b|\btest again\b/.test(t) && (kinds.length || /\btests?\b|\bsuite\b|\bchecks?\b|^retest|^re-test/.test(t))) {
    if (kinds.includes('e2e')) return result('COMMAND', [{ type: 'RUN_E2E', params: {} }]);
    if (kinds.length) return result('COMMAND', [{ type: 'RUN_FULL_TESTS', params: {} }]);
    return result('COMMAND', [{ type: 'RUN_TARGETED_TESTS', params: {} }]);
  }

  if (/\b(re-?plan|plan again|new plan|make a new plan|different plan)\b/.test(t)) {
    return result('COMMAND', [{ type: 'REPLAN', params: { guidance: `The user asked for a new plan: "${original}"` } }]);
  }
  if (/^(go back|return|back|go back a stage|go back one stage)$/.test(t)) {
    const names = ctx.stages.filter((s) => s.kind === 'agent').map((s) => s.name).slice(0, 4).join(', ');
    return result('COMMAND', [], { clarification: `Which stage should I return to? ${names}.` });
  }
  const back = /\b(go back to|return to|back to|restart from|redo|re-?run|start again from)\s+(?:the\s+)?([a-z -]+?)(?:\s+stage)?\b/.exec(t);
  if (/\b(re-?investigate|investigate again|root[- ]cause)\b/.test(t) || back) {
    const target = /\b(re-?investigate|investigate again|root[- ]cause)\b/.test(t) ? stageFrom('investigate', ctx) : stageFrom(back![2]!, ctx);
    if (!target) {
      const names = ctx.stages.filter((s) => s.kind === 'agent').map((s) => s.name).slice(0, 4).join(', ');
      return result('COMMAND', [], { clarification: `Which stage should I return to? ${names}.` });
    }
    return result('COMMAND', [{ type: 'RETURN_TO_STAGE', params: { stageKey: target.key, guidance: `The user asked: "${original}"` } }]);
  }
  if (/^(retry|try again|rerun|re-run)\b/.test(t)) {
    const stage = stageFrom(t.replace(/^(retry|try again|rerun|re-run)/, ''), ctx);
    return result('COMMAND', [{ type: 'RETRY_STAGE', params: stage ? { stageKey: stage.key } : {} }]);
  }

  const remove = /^(?:remove|drop|cancel|forget|delete|lift|clear)\s+(?:the\s+|that\s+|my\s+)?(?:directive|constraint|rule|instruction)s?\b\s*(.*)$/.exec(t);
  if (remove) {
    const needle = remove[1]!.replace(/^(about|on|that|saying|:)\s*/, '').replace(/["']/g, '').trim();
    const matches = needle ? ctx.directives.filter((d) => d.text.toLowerCase().includes(needle)) : ctx.directives;
    if (matches.length === 1) return result('DIRECTIVE', [{ type: 'REMOVE_DIRECTIVE', params: { directiveId: matches[0]!.id } }]);
    if (!matches.length) return result('DIRECTIVE', [], { note: ctx.directives.length ? 'No active directive matches that. Name a word from the one to remove.' : 'There are no active directives to remove.' });
    return result('DIRECTIVE', [], { clarification: `Which directive? ${matches.slice(0, 4).map((d, i) => `${i + 1}. "${d.text.slice(0, 60)}"`).join(' ')}` });
  }

  if (/^(finish|complete|wrap up|mark (it |the task )?(as )?(done|complete|finished))\b/.test(t)) return result('COMMAND', [{ type: 'COMPLETE_TASK', params: {} }]);
  if (/^cancel( the)?( whole)? task\b/.test(t)) {
    return result('COMMAND', [], { note: 'Cancelling ends the task permanently, so it is not done from chat. Use Cancel task in the task details if you are sure.' });
  }
  return null;
}

export function classifyMessage(raw: string, ctx: IntentContext): ParsedMessage {
  const original = raw.trim();
  const text = clean(original).toLowerCase();

  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/\s+/)[0];
    switch (cmd) {
      case 'status':
        return result('STATUS', [], { topic: 'status' });
      case 'blockers':
        return result('STATUS', [], { topic: 'blockers' });
      case 'directives':
        return result('STATUS', [], { topic: 'directives' });
      case 'retest':
        return result('COMMAND', [{ type: 'RUN_TARGETED_TESTS', params: {} }]);
      case 'replan':
        return result('COMMAND', [{ type: 'REPLAN', params: { guidance: 'The user asked for a new plan.' } }]);
      case 'pause':
        return result('COMMAND', [{ type: 'PAUSE_TASK', params: { when: 'now' } }]);
      case 'resume':
        return result('COMMAND', [{ type: 'RESUME_TASK', params: {} }]);
      case 'rollback':
        return result('COMMAND', [{ type: 'ROLLBACK_CHECKPOINT', params: {} }]);
      default:
        return result('QUESTION', [], { note: 'Shortcuts: /status /blockers /directives /retest /replan /pause /resume /rollback. Plain language works too.' });
    }
  }

  // Goal changes create a new contract version and tell every later stage.
  const goal = /^(?:change|update|set|replace)\s+(?:the\s+)?goal\s*(?:to|:)\s*(.+)$|^new goal\s*:\s*(.+)$/.exec(text);
  if (goal) {
    const newGoal = original.slice(original.length - (goal[1] ?? goal[2])!.length).trim();
    return result('GOAL_CHANGE', [{ type: 'ADD_DIRECTIVE', params: { text: `Goal changed by the user: ${newGoal}`, kind: 'instruction', scope: 'CURRENT_TASK' } }]);
  }

  const polite = POLITE_REQUEST.exec(text.replace(/\?+$/, ''));
  if (polite) {
    const command = parseCommand(polite[1]!, original, ctx);
    if (command) return command;
  }

  // "Do not …" starts like a question but is an instruction.
  const isQuestion = text.endsWith('?') || (QUESTION_START.test(text) && !/^(do not|don't|dont)\b/.test(text));
  if (isQuestion) {
    // The canned status answer only when the whole question is about status; "…and would a rollback help?" needs a real answer.
    const clauses = text.split(/[?,;]|\b(?:and|but|also|then)\b/).map((c) => c.trim()).filter(Boolean);
    if (STATUS_WORDS.test(text) && !/\bwhy\b/.test(text) && clauses.every((c) => STATUS_WORDS.test(c))) {
      return result('STATUS', [], { topic: /\bblock/.test(text) ? 'blockers' : 'status' });
    }
    return result('QUESTION', []);
  }

  const command = parseCommand(text, original, ctx);
  if (command) return command;

  const rule = deriveRule(original);
  if (/^(do not|don't|dont|never|avoid|no need to|stop (modifying|changing|touching|editing))\b/.test(text)) {
    return result('DIRECTIVE', [{ type: 'ADD_DIRECTIVE', params: { text: original, kind: 'constraint', scope: 'CURRENT_TASK', rule } }]);
  }
  if (/^(must|always|make sure|ensure|keep|prefer|only|remember|focus|next time|for the next stage|in the next stage)\b/.test(text)) {
    const next = /^(next time|for the next stage|in the next stage)\b/.test(text);
    return result('DIRECTIVE', [{ type: 'ADD_DIRECTIVE', params: { text: original, kind: 'instruction', scope: next ? 'NEXT_RELEVANT_STAGE' : 'CURRENT_TASK', rule } }]);
  }
  // Anything else is kept as a directive (visible, removable), unless the model reads it differently.
  return result('DIRECTIVE', [{ type: 'ADD_DIRECTIVE', params: { text: original, kind: 'instruction', scope: 'CURRENT_TASK', rule } }], { confident: false });
}

/**
 * The kind and machine-checkable rule of a directive, derived only from the
 * operator's own words — never taken from a model's proposal (audit F-36).
 */
export function directiveFromWords(text: string): { kind: 'constraint' | 'instruction' | 'requirement'; rule: ReturnType<typeof deriveRule> } {
  const rule = deriveRule(text);
  if (rule?.type === 'require_check') return { kind: 'requirement', rule };
  const t = clean(text).toLowerCase();
  if (/^(do not|don't|dont|never|avoid|no need to|stop (modifying|changing|touching|editing))\b/.test(t)) return { kind: 'constraint', rule };
  return { kind: 'instruction', rule };
}

/** Actions a model may add when interpreting an ambiguous sentence: nothing that discards work. */
export const INTERPRETABLE_ACTIONS: ReadonlySet<ChairmanActionInput['type']> = new Set([
  'ADD_DIRECTIVE',
  'CHANGE_AGENT',
  'CHANGE_MODEL',
  'CHANGE_EFFORT',
  'RUN_TARGETED_TESTS',
  'RUN_FULL_TESTS',
  'RUN_E2E',
  'RETRY_STAGE',
  'RETURN_TO_STAGE',
  'REPLAN',
  'PAUSE_TASK',
  'RESUME_TASK',
  'CONTINUE',
  'CREATE_CHECKPOINT',
]);
