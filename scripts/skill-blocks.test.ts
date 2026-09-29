import { describe, expect, it } from 'vitest';
import { GENERATED_BLOCK_IDS, renderBlock } from './skill-blocks.js';

const SENTINELS: Record<string, string> = {
  'brief-template': '### Escalation',
  'brief-contract': '9. **Evidence**',
  'critical-rules': '9. **Reserved delimiter**',
  'implementer-preamble': 'directly in the working directory.',
  'closing-constraints': 'Do NOT import packages not listed in the project dependencies',
  'retry-framings': 'Try a completely different approach:',
  'ladder-table': '| `takeover` | planner |',
  'halt-signatures': '`credit balance is too low`',
  'halt-signatures-sh': "*'sandbox required but unavailable'*) halt=spawn ;;",
  'gate-rules': 'typecheck → lint → test',
  gates: 'uv run pytest',
  'modes-table': '| `speckit` | 6-7 | spec, plan, briefs |',
  'brief-grouping': 'no file-count or line-count threshold decides a boundary',
  'body-order': '`### Current Code` is never sent to a direct writer',
  'closing-line': 'Edit <file>, <second file> directly in the working directory.',
  'scope-rule': 'Revert your changes to',
  'baseline-rule': '`baseline-sha.txt`',
  timeouts: '--deadline 1200',
  'plain-shapes': 'task T001: done (',
  'wait-protocol': 'never in the same tool call as the spawn',
  'hint-placement': '## Hints from senior reviewer:',
  'verdict-rules': 'exactly one verdict word under ### Verdict',
  'fix-cycle': 'At most 2 review cycles',
  'hint-prompt': '# Diagnose Implementation Failure',
  'takeover-prompt': '# Escalation: Implement Fix',
  'review-packet': '`pass` | `pass_with_notes` | `fail`',
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
  it('renders every declared block from the CLI sources', () => {
    expect([...GENERATED_BLOCK_IDS].sort()).toEqual(Object.keys(SENTINELS).sort());
    for (const [id, sentinel] of Object.entries(SENTINELS)) {
      expect(renderBlock(id), id).toContain(sentinel);
    }
  });

  it('lists the direct-writer body without Current Code and renumbers what follows', () => {
    const order = renderBlock('body-order') ?? '';
    expect(order).not.toMatch(/^\d+\. `### Current Code`$/m);
    expect(order).toContain('4. `### Pattern`');
    expect(order).toContain('5. `### Implementation Steps`');
    expect(order).toContain('10. `### Constraints`');
    expect(order).not.toContain('11.');
  });

  it('applies the skill substitutions to the implementer preamble', () => {
    const preamble = renderBlock('implementer-preamble') ?? '';
    expect(preamble).not.toContain('isolation directory');
    expect(preamble).not.toContain('promoted');
    expect(preamble).toContain('the orchestrator runs them again afterwards');
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
});
