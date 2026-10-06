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
import { GATE_ORDER } from '../src/core/pipeline-spec/gates.js';
import { GENERATED_BLOCK_IDS, renderBlock } from './skill-blocks.js';
import { runSyncCli } from './sync-skills.js';

const SENTINELS: Record<string, string> = {
  'brief-template': '### Escalation',
  'implementer-preamble': 'directly in the working directory.',
  'consult-contract': 'Answer with exactly one JSON object',
  'consult-table': '| `verify` | Run the named registered checks',
  'seat-recovery': 'retries with backoff',
  'halt-signatures': '`credit balance is too low`',
  'halt-signatures-sh': "*'sandbox required but unavailable'*) halt=spawn ;;",
  'gate-rules': 'typecheck → lint → test',
  gates: 'uv run pytest',
  'brief-grouping': 'no file-count or line-count threshold decides a boundary',
  'body-order': '`### Current Code` is never sent to a direct writer',
  'closing-line': 'Edit <file>, <second file> directly in the working directory.',
  'suggested-files': 'Suggested files are guidance',
  'baseline-rule': '`baseline-sha.txt`',
  timeouts: '--deadline 1200',
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
      "The orchestrator runs the project's typecheck, lint and test gates after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other gate command, not even the tests you write or a command the brief names.",
    );
    expect(preamble).not.toMatch(/run at most/i);
    expect(preamble).toContain('never run a package-manager install');
  });

  it('gives the gates to the orchestrator in the closing line', () => {
    const closing = renderBlock('closing-line') ?? '';
    expect(closing).not.toContain('SPLITBRIEF');
    for (const line of closing.split('\n')) {
      expect(line).toContain(
        `The orchestrator runs the ${GATE_ORDER.join(', ')} gates after you hand back, so run no test or other gate command.`,
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
        '| `verify` | Run the named registered checks',
      );
      expect(statSync(mirror).mtimeMs).toBe(before);
      expect(runSyncCli(root, true, () => {}, renderBlock)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
