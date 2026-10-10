import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNDS } from '../src/core/pipeline-spec/bounds.js';
import { ReviewAnswerSchema } from '../src/core/schemas/review.js';
import { RUNNER_IDLE_WARN_MS } from '../src/core/schemas/runner-fields.js';
import { GENERATED_BLOCK_IDS, renderBlock } from './skill-blocks.js';
import { runSyncCli } from './sync-skills.js';

const SENTINELS: Record<string, string> = {
  'brief-template': '### Escalation',
  'implementer-preamble': 'directly in the working directory.',
  'consult-contract': 'Answer with exactly one JSON object',
  'consult-table': '| `verify` | Run the brief gate and named registered checks',
  'seat-recovery': 'retries with backoff',
  'halt-signatures': '`credit balance is too low`',
  'halt-signatures-sh': "*'sandbox required but unavailable'*) halt=spawn ;;",
  'gate-rules': 'Stop at the first reviewer check with new failures',
  gates: 'uv run pytest',
  'brief-grouping': 'no file-count or line-count threshold decides a boundary',
  'body-order': '`### Current Code` is never sent to a direct writer',
  'closing-line': 'Edit <file>, <second file> directly in the working directory.',
  'suggested-files': 'Suggested files are guidance',
  'baseline-rule': '`baseline-sha.txt`',
  timeouts: 'Seat calls have no default deadline',
  'wait-protocol': 'never in the same tool call as the spawn',
  'verdict-rules': 'every task met, every criterion pass, no blocking finding',
  'fix-cycle': 'Allow 2 fix cycles',
  'review-packet': 'The session derives the verdict',
  'recipe:claude-code': `"blockReadsOutsideWorkingDirectories":true}}'\\'' < $P`,
  'recipe:codex': '--sandbox read-only',
  'recipe:opencode': '--agent plan "$(cat $P)"',
  'recipe:copilot': '--allow-all --output-format json >',
  'recipe:kilo-code': '--agent code --auto',
  'recipe:cursor': '--mode plan --trust',
  'recipe:command-code': '--yolo -m $M --effort $E',
  'recipe:antigravity': '--dangerously-skip-permissions --add-dir $D --output-format stream-json',
};

describe('skill-blocks', () => {
  it('renders every declared block from engine contracts and the agreed design', () => {
    expect([...GENERATED_BLOCK_IDS].sort()).toEqual(Object.keys(SENTINELS).sort());
    for (const [id, sentinel] of Object.entries(SENTINELS)) {
      expect(renderBlock(id), id).toContain(sentinel);
    }
  });

  it('sends a direct writer the read-only context code where Current Code would stand', () => {
    const order = renderBlock('body-order') ?? '';
    expect(order).not.toMatch(/^\d+\. `### Current Code`$/m);
    expect(order).toContain('4. `### Pattern`');
    expect(order).toContain('5. `### Read-only context (do not modify) — <path>`');
    expect(order).toContain('6. `### Implementation Steps`');
    expect(order).toContain('11. `### Constraints`');
  });

  it('maps contextFiles to the read-only context section in the brief template', () => {
    const template = renderBlock('brief-template') ?? '';
    expect(template).toContain(
      '`contextFiles` → one `### Read-only context (do not modify) — <path>` section per file',
    );
    expect(template).not.toContain('under `### Current Code`');
  });

  it('carries the plan context in the brief template', () => {
    const template = renderBlock('brief-template') ?? '';
    expect(template).toContain('Plan context (read-only)');
    expect(template).toContain('"decisions":[]');
  });

  it('uses workspace rules and gives validation to the session', () => {
    const preamble = renderBlock('implementer-preamble') ?? '';
    expect(preamble).not.toContain('isolation directory');
    expect(preamble).not.toContain('promoted');
    expect(preamble).not.toContain('SPLITBRIEF');
    expect(preamble).toContain(
      'The orchestrator runs the checks after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests you write or a command the brief names.',
    );
    expect(preamble).not.toMatch(/run at most/i);
    expect(preamble).toContain('never run a package-manager install');
  });

  it('gives the checks to the orchestrator in the closing line', () => {
    const closing = renderBlock('closing-line') ?? '';
    expect(closing).not.toContain('SPLITBRIEF');
    for (const line of closing.split('\n')) {
      expect(line).toContain(
        'The orchestrator runs the checks after you hand back, so run no test, typecheck, lint or other check command.',
      );
      expect(line).not.toContain('format');
    }
  });

  it('renders seat retries and the reset-wait exception from BOUNDS', () => {
    const recovery = renderBlock('seat-recovery');
    expect(recovery).toContain(`${BOUNDS.transientRetries} retries with backoff`);
    expect(recovery).toContain(`${BOUNDS.rateLimitResetWaitMs / 60_000} minutes`);
    expect(recovery).toContain('reported reset');
    expect(recovery).toContain('Longer or unknown resets');
  });

  it('states the account rule, the declared fallback and the retry-later row', () => {
    const recovery = renderBlock('seat-recovery') ?? '';
    expect(recovery).toContain('account refusal');
    expect(recovery).toContain('balance, billing, a quota with no reset, or sign-in');
    expect(recovery).toContain('halts at once as seat down');
    expect(recovery).toContain(
      'A declared `fallback` switches the seat once per run with no question',
    );
    expect(recovery).toContain('`Retry at <clock>`');
    expect(recovery).toContain('offered only with a known reset');
  });

  it('states the waiter process-group limit and reconciles fallback timeouts before recovery', () => {
    const timeouts = renderBlock('timeouts') ?? '';
    expect(timeouts).toContain('separate process group');
    expect(timeouts).toContain('otherwise only the recorded PID');
    expect(timeouts).not.toContain('kills the process group');
    const fallback = (renderBlock('wait-protocol') ?? '')
      .split('\n')
      .find((line) => line.includes('Fallback,'));
    expect(fallback).toContain('reconcile the recorded PID and its implementer children');
    expect(fallback).toContain('Confirm they are gone, or stop them and confirm exit');
    expect(fallback).toContain('before recovery or another dispatch');
  });

  it('waits without a default deadline and warns on silence without killing the call', () => {
    const timeouts = renderBlock('timeouts') ?? '';
    expect(timeouts).toContain('default ' + RUNNER_IDLE_WARN_MS + ' ms');
    expect(timeouts).toContain('Continue the call after the warning');
    expect(timeouts).toContain('Without either limit, never kill a silent call');
    expect(timeouts).toContain('2 consecutive timeouts on one brief with an explicit limit');
    const wait = renderBlock('wait-protocol') ?? '';
    expect(wait).toContain('Add `--deadline <seconds>` only for an explicit limit');
    expect(wait).toContain('! kill -0 "$pid"');
    expect(wait).toContain('[ "$elapsed" -ge "$N" ] && { echo exit=timeout; exit; }');
    for (const text of [timeouts, wait]) {
      expect(text).not.toMatch(/--deadline \d+|minutes per attempt|-ge 1200/u);
    }
  });

  it('replaces scope checks with file guidance', () => {
    expect(renderBlock('suggested-files') ?? '').not.toMatch(/revert|drift|reject/i);
    expect(renderBlock('scope-rule')).toBeNull();
  });

  it('replaces the hint blocks with the consult contract', () => {
    const contract = renderBlock('consult-contract') ?? '';
    for (const action of ['guidance', 'rewrite-task', 'split-task', 'verify', 'ask-user']) {
      expect(contract, action).toContain(`\`${action}\``);
    }
    expect(contract).toContain('a rewrite or a split never drops a criterion id');
    expect(contract).toContain('This call is read-only');
    expect(contract).toContain('## Guidance from the planner:');
    expect(renderBlock('hint-prompt')).toBeNull();
    expect(renderBlock('hint-placement')).toBeNull();
  });

  it('renders the consult-contract block with the CLI fallback schema', () => {
    const contract = renderBlock('consult-contract') ?? '';
    expect(contract).toContain('matches this schema:');
    expect(contract).toContain('"split-task"');
  });

  it('renders the consult bounds from BOUNDS, not by hand', () => {
    const contract = renderBlock('consult-table') ?? '';
    expect(contract).toContain('2 consults and 8 attempts');
    expect(contract).toContain('10 planner decisions');
    expect(contract).toContain('4 more attempts');
    expect(contract).toContain('5 more planner decisions');
  });

  it('keeps reported decisions out of the consult bounds and replays a continued brief with its errors', () => {
    const contract = renderBlock('consult-table') ?? '';
    expect(contract).toContain('decision-confirm before validation');
    expect(contract).toContain(
      "Decision-confirm runs at most once per attempt, bounded by the brief's attempts.",
    );
    expect(contract).toContain(
      'It spends no run counter, never a lineage consult or a planner decision.',
    );
    expect(contract).toContain(
      'A failed or malformed confirm answer warns, leaves the decisions out of the ledger and validates. It never pauses.',
    );
    expect(contract).toContain('replays the brief as a retry with the last failing output');
  });

  it('every recipe writes its exit code and none invokes coreutils timeout', () => {
    const recipes = GENERATED_BLOCK_IDS.filter((id) => id.startsWith('recipe:'));
    expect(recipes.length).toBeGreaterThan(0);
    for (const id of recipes) {
      const rendered = renderBlock(id) ?? '';
      for (const line of rendered.split('\n')) {
        expect(line, id).toContain('echo "exit=$?" > $DONE');
        expect(line, id).not.toMatch(/(^|[;&| ])timeout [0-9]/u);
      }
    }
  });

  it('spawns the codex reviewer ephemeral, since nothing resumes a detached review', () => {
    const reviewers = (renderBlock('recipe:codex') ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- reviewer'));
    expect(reviewers).toHaveLength(2);
    for (const line of reviewers) expect(line).toContain('--ignore-rules --ephemeral --json');
  });

  it('returns null for an unknown block id', () => {
    expect(renderBlock('nope')).toBeNull();
    expect(renderBlock('recipe:nope')).toBeNull();
  });

  it('keeps generated procedures in their canonical references and removes unused blocks', () => {
    const root = new URL('../skills/', import.meta.url);
    const library = new URL('splitbrief/references/', root);
    const homes = {
      'consult-table': 'recovery.md',
      'consult-contract': 'recovery.md',
      'fix-cycle': 'recovery.md',
      'wait-protocol': 'run-protocol.md',
      'seat-recovery': 'tool-recipes.md',
    };
    const references = readdirSync(library).map((name) => ({
      name,
      text: readFileSync(new URL(name, library), 'utf8'),
    }));
    for (const [id, home] of Object.entries(homes)) {
      expect(references.filter(({ text }) => text.includes(`<!-- generated: ${id} -->`))).toEqual([
        expect.objectContaining({ name: home }),
      ]);
    }
    for (const skill of ['splitbrief', 'splitbrief-brief', 'splitbrief-run', 'splitbrief-review']) {
      expect(readFileSync(new URL(`${skill}/SKILL.md`, root), 'utf8')).not.toContain(
        '<!-- generated:',
      );
    }
    expect(renderBlock('plain-shapes')).toBeNull();
    const authored =
      references.map(({ text }) => text).join('\n') +
      readFileSync(new URL('splitbrief-run/scripts/wait-attempt.sh', root), 'utf8');
    for (const id of GENERATED_BLOCK_IDS) expect(authored).toContain(`generated: ${id}`);
  });

  it('renders consult actions and shared bounds without a takeover', () => {
    const consult = renderBlock('consult-table') ?? '';
    for (const action of ['guidance', 'rewrite-task', 'split-task', 'verify', 'ask-user']) {
      expect(consult).toContain(`| \`${action}\` |`);
    }
    expect(consult).toContain('same id and the same criteria');
    expect(consult).toContain('Replace with 2–4 subtasks');
    expect(consult).toContain('2 consults and 8 attempts');
    expect(consult).toContain('10 planner decisions after planning');
    expect(consult).toContain('stale');
    expect(consult).not.toMatch(/takeover|ladder/iu);
    expect(renderBlock('ladder-table')).toBeNull();
    expect(renderBlock('takeover-prompt')).toBeNull();
    expect(renderBlock('retry-framings')).toBeNull();
  });

  it('requires user confirmation for protected writes and carries proposed decisions', () => {
    const preamble = renderBlock('implementer-preamble') ?? '';
    expect(preamble).toContain('user confirmation');
    expect(preamble).not.toContain('unless the brief explicitly asks');
    expect(preamble).toContain('"decisions":[{"what":"<proposed deviation>","why":"<reason>"}]');
    expect(preamble).toContain('advisory');
    expect(preamble).toContain('render checks are unavailable');
  });

  it('states the reviewer-check rules: plan call, stop rule, base re-run and refusal scope', () => {
    const rules = renderBlock('gate-rules') ?? '';
    expect(rules).toContain('A failed plan call halts the review');
    expect(rules).toContain('a plan or task check is never refused for that');
    expect(rules).toContain(
      'Plan checks, task checks and the Apply re-check never re-run at the run base',
    );
    expect(rules).toContain('With End-of-run checks off, no reviewer check runs');
    expect(rules).not.toMatch(/typecheck → lint|full suite|verification plan/iu);
  });

  it('keeps the unique gate policy and requires a passing fix command for incomplete capture', () => {
    const rules = renderBlock('gate-rules') ?? '';
    expect(rules).toContain('With an incomplete capture, the fix command must pass');
    expect(rules).toContain('`not run: <id> failed`');
    expect(rules).toContain('Makefile or justfile, CI configuration and README');
    expect(rules).toContain('If it chooses no reviewer check, record its reason');
    expect(rules).toContain('`mvn test`, `bundle exec rspec` or `make check`');
    expect(rules).toContain('an environment prefix');
    expect(rules).toContain('`npm ci`, `pip install`, `go generate`');
    expect(rules).toContain('Keep every original red key before the base split');
    expect(rules).toContain('The reviewer addresses every pending input in its review answer');
    const gates = readFileSync('skills/splitbrief/references/gates.md', 'utf8');
    expect(gates).not.toContain('### End-of-run checks');
  });

  it('returns verdict and fix work in one schema-valid review answer', () => {
    const packet = renderBlock('review-packet') ?? '';
    const example = packet.split('\n').find((line) => line.trim().startsWith('{"tasks":'));
    if (example === undefined) throw new Error('review packet has no example answer');
    const answer: unknown = JSON.parse(example);
    const parsed = ReviewAnswerSchema.parse(answer);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.ask?.question).toBe(parsed.findings[0]?.text);
    expect(packet).toContain('Save the whole answer in review.json');
    expect(renderBlock('fix-cycle')).toContain('from the saved review fix part');
    expect(renderBlock('consult-table')).toContain(
      'Reviewer consults and review answers spend no planner decision',
    );
    for (const id of ['review-packet', 'fix-cycle', 'consult-table', 'gate-rules']) {
      expect(renderBlock(id)).not.toMatch(/triage log|session for triage|triage turns|and triage/u);
    }
  });

  it('renders typed review coverage and appends fixes instead of reopening completed tasks', () => {
    const packet = renderBlock('review-packet') ?? '';
    expect(packet).toContain('Plan context');
    expect(packet).toContain('plan: met, partial or missed');
    expect(packet).toContain('status: pass, fail or unverified');
    expect(packet).toContain('kind: defect, plan-gap, unverified or question');
    expect(packet).not.toMatch(/drift|Critical|### Verdict/iu);
    const rules = renderBlock('verdict-rules') ?? '';
    expect(rules).toContain('every task met');
    expect(rules).toContain('every criterion pass');
    expect(rules).toContain('no blocking finding');
    expect(rules).toContain('Pending criteria');
    const fixes = renderBlock('fix-cycle') ?? '';
    expect(fixes).toContain('new ids');
    expect(fixes).toContain('2 fix cycles');
    expect(fixes).toContain('3 reviews');
    expect(fixes).not.toMatch(/reopen|last brief|path substring/iu);
    expect(fixes).toContain('references/gates.md');
    expect(fixes).not.toContain('Re-run the full suite');
  });

  it('syncs the recovery block without rewriting an unchanged babysit script mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-blocks-sync-'));
    try {
      for (const name of ['splitbrief', 'splitbrief-run', 'splitbrief-babysit']) {
        mkdirSync(join(root, name, 'scripts'), { recursive: true });
        const body = name === 'splitbrief' ? 'references/recovery.md' : 'scripts/watch-run.mjs';
        writeFileSync(
          join(root, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Test.\nmetadata:\n  argument-hint: test\n---\n${body}\n`,
        );
      }
      mkdirSync(join(root, 'splitbrief', 'references'));
      writeFileSync(
        join(root, 'splitbrief', 'references', 'recovery.md'),
        '<!-- generated: consult-table -->\n<!-- /generated -->\n',
      );
      const source = join(root, 'splitbrief-run', 'scripts', 'watch-run.mjs');
      const mirror = join(root, 'splitbrief-babysit', 'scripts', 'watch-run.mjs');
      writeFileSync(source, 'watch();\n');
      writeFileSync(mirror, 'watch();\n');
      utimesSync(mirror, 1, 1);
      const before = statSync(mirror).mtimeMs;
      expect(runSyncCli(root, false, () => {}, renderBlock)).toBe(0);
      expect(readFileSync(join(root, 'splitbrief/references/recovery.md'), 'utf8')).toContain(
        '| `verify` | Run the brief gate and named registered checks',
      );
      expect(statSync(mirror).mtimeMs).toBe(before);
      expect(runSyncCli(root, true, () => {}, renderBlock)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
