import { getLLMText, type LLMPage } from './get-llm-text.js';

const MAX_INDEX_BYTES = 5_120;
const INDEX_INTRODUCTION = `# SPLITBRIEF

> Pair a supported planner runner with a supported implementer runner. The Task Brief is the contract between them.

## Documentation`;

export function buildLLMsIndex(pages: readonly LLMPage[], origin: string): string {
  const links = pages.map(
    (page) => `- [${page.data.title}](${new URL(`${page.url}.md`, origin).href})`,
  );
  const index = `${INDEX_INTRODUCTION}\n\n${links.join('\n')}\n`;

  if (new TextEncoder().encode(index).byteLength > MAX_INDEX_BYTES) {
    throw new RangeError('llms.txt exceeds its 5120-byte budget');
  }

  return index;
}

export async function buildLLMsFullText(pages: readonly LLMPage[]): Promise<string> {
  const documents = await Promise.all(pages.map(getLLMText));
  return documents.join('\n\n---\n\n');
}
