import { describe, expect, it } from 'vitest';
import { getLLMText, type LLMPage } from './get-llm-text.js';

function page(data: Partial<LLMPage['data']> = {}): LLMPage {
  return {
    url: '/docs/getting-started/introduction',
    data: {
      title: 'Introduction',
      description: 'Pair a planner with an implementer through Task Briefs.',
      getText: async () => '\n\n## The contract\n\nThe planner thinks. The implementer types.',
      ...data,
    },
  };
}

describe('getLLMText', () => {
  it('prepends page identity and description to processed Markdown', async () => {
    await expect(
      getLLMText(page()),
    ).resolves.toBe(`# Introduction (/docs/getting-started/introduction)

> Pair a planner with an implementer through Task Briefs.

## The contract

The planner thinks. The implementer types.`);
  });

  it('omits the description block when a page has no description', async () => {
    await expect(
      getLLMText(page({ description: undefined })),
    ).resolves.toBe(`# Introduction (/docs/getting-started/introduction)

## The contract

The planner thinks. The implementer types.`);
  });
});
