import { describe, expect, it } from 'vitest';
import { fixBriefDescription } from './fix-task.js';

describe('fixBriefDescription', () => {
  it('fences a failing output with more backticks than any run inside it', () => {
    const output = 'expected:\n```ts\nhello()\n```\nreceived: ````';
    const description = fixBriefDescription('Fix the greeting', [
      { id: 'P1', text: 'The test failed', acceptance: null, output },
    ]);

    const fence = '`'.repeat(5);
    expect(description).toContain(`Failing output:\n${fence}\n${output}\n${fence}`);
  });
});
