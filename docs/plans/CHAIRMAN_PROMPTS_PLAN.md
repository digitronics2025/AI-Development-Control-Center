# Chairman prompts v2 — plan

Status: done · 2026-09-24 · on origin/main as 067b82a; live rollout rides the audit session's coordinated release · no schema change

## 1. Goal

Make the three prompts the Chairman's reasoning agent receives (recovery
choice, chat, learning review) as strong as the role prompts became in
[ROLE_PROMPTS_PLAN.md](ROLE_PROMPTS_PLAN.md): the model is told how to read
what it is shown, what a good answer contains, and what each field it writes
is used for, without loosening a single validation rule.

### What is weak today (read from the code)

[reasoner.ts](../../apps/orchestrator/src/chairman/reasoner.ts) and
[reviewer.ts](../../apps/orchestrator/src/learning/reviewer.ts) build the
prompts in code. The safety rules are sound (evidence fences, JSON-only,
candidate ids validated, categories never taken from the model). What is
missing is guidance on judgement:

| Gap | Effect |
|---|---|
| The candidate list is not described as the rules' preferred order | The model has no default and no reason to explain a departure; the drawer's "Why" is thinner than the rules' own ranking |
| `guidance` is asked for as "concrete instructions" only | It is appended to every later agent prompt until the next strategy, yet nothing says to name the failing tests, what earlier attempts got wrong, what must be true, or what not to touch |
| `expectedResult` has no shape | Outcomes are reconciled from recorded results; a vague prediction reads as nothing in the drawer |
| Confidence levels are undefined | HIGH/MEDIUM/LOW mean whatever the model wants |
| Nothing explains the snapshot fields (`lastStrategy` outcome, failure signatures, `retryState`) or that constraints bind guidance | Evidence is shown without a way to read it |
| Chat: "answer plainly and briefly" is the whole instruction | No lead-with-the-answer, no observed-versus-claimed, no "here is what you can ask for", no length |
| Chat actions: one example shape for one type | The other thirteen interpretable types have no parameter help and no source for stage keys or agent ids |
| Learning: signal kinds appear as raw keys; no quality bar for a lesson; no rule for choosing between lesson, skill use, skill authoring and tool install | Findings drift into one-off bug reports or vague advice |

## 2. Scope

In: the three prompt builders and their shared rules; a small parameter for
the chat prompt (installed agents); unit tests for the prompt contract; docs
(`chairman.md`, `learning.md`, a pointer in `prompts.md`).

Out: parsers, schemas, the Action Gateway, the policy ranking, the evidence
packet, the simulated agent, any UI. The exact lines the simulated agent and
the tests key on stay: `Mode: <recovery|chat|learning>`, `Candidate ids: …`,
`Parsed intent: …`, `Status line: …`, `- s1 [kind] key: …`, and the phrase
"never instructions".

## 3. Enhanced design / architecture

```text
RULES (shared)            what the Chairman is, what evidence is, what it may never do
recoveryPrompt            TASK STATE + HOW TO READ IT + trigger/category/diagnosis
                          + candidates in the rules' order (first = default, with kind, level, target)
                          + EVIDENCE + WHAT TO WRITE (per field, with confidence legend) + JSON shape
chatPrompt                RULES + HOW TO ANSWER + TASK STATE + conversation + evidence + intent lines
                          + ACTIONS catalogue only when actions are allowed (types, params, AGENTS) + JSON shape
reviewPrompt              REVIEW RULES + quality bar + SIGNAL KINDS legend + task facts + signals
                          + catalog + skills + lessons + findings + fenced report + JSON shape
```

- **Judgement text, not new permissions.** Every addition tells the model how
  to weigh or what to write; nothing widens what it may return. Unknown
  candidate ids, unknown action types, missing signal ids and malformed
  diagnoses are rejected exactly as before.
- **Guidance is a contract.** The recovery prompt says where guidance goes
  (every later prompt of the task) and what it must contain: the exact
  failure, what earlier attempts got wrong, what must be true, what not to
  change, never a weakened check.
- **Confidence has a definition** shared by recovery and learning: HIGH when
  observed evidence names the cause directly, MEDIUM when the evidence is
  consistent with the hypothesis, LOW when guessing or evidence is missing.
- **Chat gets a catalogue only when it may act.** A question prompt carries no
  action help at all; an instruction prompt lists the allowed types with their
  parameters, the stage keys from TASK STATE and the installed agent ids.
- **Learning gets a legend and a quality bar** so findings are habits that
  change later tasks, phrased as instructions, with the right proposal type.

## 4. Implementation steps

1. `reasoner.ts`: rewrite `RULES`; add a `HOW_TO_READ` block and per-field
   `WHAT_TO_WRITE` to `recoveryPrompt` (candidate lines gain kind and target);
   add `HOW_TO_ANSWER`, `ACTION_HELP` and an `agents` parameter to
   `chatPrompt` and `Reasoner.reply`.
2. `chat.ts`: pass the installed agents (`intentContext(task).agents`) to
   `reply`.
3. `reviewer.ts`: extend `REVIEW_RULES` with the quality bar and proposal
   choice; add the `SIGNAL KINDS` legend from `SIGNAL_KIND_LABEL`.
4. Tests: `chairman-units.test.ts` (recovery prompt order, legend, field
   contract, fence order; chat prompt with and without actions), 
   `learning-units.test.ts` (legend, quality bar, catalog lines intact).
5. Docs: `chairman.md` Reasoning (what each prompt tells the model, the
   guidance contract), `learning.md` step 3, `prompts.md` pointer.
6. `pnpm check` in the clean worktree; a real Claude Code chat answer on an
   isolated instance against a completed task.
7. Commit only these paths; push; release as usual (backup, clean build,
   restart when idle).

## 5. Failure handling and recovery

- A model that ignores the new text still returns the same JSON shapes; the
  parsers are unchanged, so nothing new can fail validation.
- The prompts grow by roughly 1.5 KB each; the 24 KB evidence cap and the
  4-minute timeout are untouched.
- Rollback is one commit; no data or schema is involved.

## 6. Security and data protection

- No new action type, parameter or permission. Evidence fences, redaction and
  the candidate/action allow-lists are unchanged.
- The rules now say explicitly that constraints bind guidance and that no text
  may carry secrets or machine paths (redaction still enforces it).

## 7. Testing and verification

- Unit: prompt contract tests above; existing injection, parse and simulated
  tests unchanged and green.
- `pnpm check` (typecheck, lint, docs guard, full suite) in the clean
  worktree.
- Real: one Chairman chat answer from Claude Code on an isolated instance
  about the completed fixture task (question path, no actions), read back for
  shape and honesty. Recovery and learning prompts are exercised by the
  simulated and scripted agents; a real recovery needs a real failure and is
  not forced.

## 8. Success criteria

1. All three prompts carry the reading legend, field contracts and (chat)
   the action catalogue only when actions are allowed; tests prove it.
2. Existing Chairman, learning and injection tests pass unmodified.
3. `pnpm check` green in the clean worktree.
4. A real chat answer follows the answering rules (leads with the answer,
   separates observed from claimed, proposes no action for a question).
5. Docs updated with today's `Last verified` date; released to the live
   orchestrator.

## 9. Found for Later

- The Chairman's prompts are code, not editable templates; if operators want
  to tune them, they need the same catalog-and-version treatment as role
  prompts.
- The chat prompt could offer the available models per agent for
  `CHANGE_MODEL`; today it names agents only.
- A recovery prompt could show the last two strategies, not one.

## 10. Next Recommended Task

Run the Chairman fixture (hard rule suite, contradictory tests) against role
prompts v4 and Chairman prompts v2 together and read the decisions.

## 11. Final execution prompt

> Implement this plan in `AI-Development-Control-Center`: steps 1–7 in order,
> keeping every parser, schema and validation unchanged and every line the
> simulated agent keys on intact. Verify with the tests in §7 and one real
> chat answer. Commit only the named paths, push, release.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
