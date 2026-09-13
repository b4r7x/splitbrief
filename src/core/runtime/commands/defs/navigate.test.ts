import { describe, it, expect } from 'vitest';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { navigateCommands } from './navigate.js';

function skillsCommand(ctx: ReturnType<typeof makeCtx>) {
  const cmd = navigateCommands(ctx).find((c) => c.name === '/skills');
  if (cmd?.kind !== 'arg') throw new Error('/skills is not an argument command');
  return cmd;
}

describe('navigateCommands /skills', () => {
  it('toggle rescans the roots before toggling', async () => {
    // The rescan resolves a tick later, so a toggle that does not await it reads
    // the pre-rescan catalog and reports a skill that exists as unknown.
    const available = new Set<string>();
    let refreshes = 0;
    const messages: string[] = [];
    const errors: string[] = [];
    const ctx = makeCtx({
      refreshSkills: async () => {
        await Promise.resolve();
        refreshes += 1;
        available.add('x');
      },
      toggleSkill: (id) =>
        available.has(id) ? { status: 'selected', name: id } : { status: 'unknown' },
      setFeedbackMessage: (msg) => messages.push(msg),
      setFeedbackError: (msg) => errors.push(msg),
    });

    await skillsCommand(ctx).handler('x');

    expect(refreshes).toBe(1);
    expect(messages).toEqual(['Attached: x']);
    expect(errors).toEqual([]);
  });

  it('completes its ids fuzzily across every token', () => {
    const cmd = skillsCommand(makeCtx());
    expect(cmd.args).toMatchObject({ kind: 'closed', multi: true, match: 'fuzzy' });
  });
});
