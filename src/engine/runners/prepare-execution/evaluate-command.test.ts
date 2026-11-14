import { describe, expect, it } from 'vitest';
import { customRunnerRefusal } from './evaluate-command.js';

describe('customRunnerRefusal', () => {
  it.each([
    ['shell', 'a shell runner command'],
    ['agent', 'an agent runner command'],
  ] as const)('names %s with its article in every refusal', (kind, phrase) => {
    const reasons = (['missing', 'non-executable', 'untrusted'] as const).map(
      (status) => customRunnerRefusal({ kind: 'denied', status }, kind).reason,
    );

    for (const reason of reasons) expect(reason).toContain(`declares ${phrase} that`);
  });
});
