import { describe, expect, it } from 'vitest';
import { GENERATED_BLOCK_IDS, renderBlock } from './skill-blocks.js';

const SENTINELS: Record<string, string> = {
  'brief-template': '### Escalation',
  'brief-contract': '9. **Evidence**',
  'critical-rules': '9. **Reserved delimiter**',
  'implementer-preamble': 'directly in the working directory.',
  'closing-constraints': 'Do NOT import packages not listed in the project dependencies',
  'retry-framings': 'Try a completely different approach:',
  'hint-prompt': '# Diagnose Implementation Failure',
  'takeover-prompt': '# Escalation: Implement Fix',
  'review-packet': '`pass` | `pass_with_notes` | `fail`',
  'recipe:claude-code': '--permission-mode acceptEdits < $P',
  'recipe:codex': '--sandbox read-only',
  'recipe:opencode': '--agent plan "$(cat $P)"',
  'recipe:copilot': '--allow-all >',
  'recipe:kilo-code': '--agent code --auto',
  'recipe:cursor': '--mode plan --trust',
  'recipe:command-code': '--yolo -m $M --effort $E',
};

describe('skill-blocks', () => {
  it('renders every declared block from the CLI sources', () => {
    expect([...GENERATED_BLOCK_IDS].sort()).toEqual(Object.keys(SENTINELS).sort());
    for (const [id, sentinel] of Object.entries(SENTINELS)) {
      expect(renderBlock(id), id).toContain(sentinel);
    }
  });

  it('applies the skill substitutions to the implementer preamble', () => {
    const preamble = renderBlock('implementer-preamble') ?? '';
    expect(preamble).not.toContain('isolation directory');
    expect(preamble).not.toContain('promoted');
    expect(preamble).toContain('the orchestrator runs them again afterwards');
  });

  it('returns null for an unknown block id', () => {
    expect(renderBlock('nope')).toBeNull();
    expect(renderBlock('recipe:nope')).toBeNull();
  });
});
