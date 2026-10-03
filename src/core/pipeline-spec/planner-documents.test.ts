import { describe, expect, it } from 'vitest';
import {
  headingMatchesSection,
  isPlannerDocument,
  PLANNER_DOCUMENT_SECTIONS,
} from './planner-documents.js';

function document(headings: readonly string[]): string {
  return headings.map((heading) => `${heading}\nBody line.\n`).join('\n');
}

// The headings of the parked P01 research reply (2026-09-29-use-one-list-grammar-…/state.json).
const parkedResearch = document([
  '# Research report: P01, one list grammar across the TUI',
  '## Project Overview',
  '## Architecture (the parts P01 touches)',
  '## Relevant Code: citation check on the launch tree (HEAD `992a1160`)',
  '## Patterns to Follow',
  '## Dependencies & Constraints',
  '## Implementation Considerations: proposed brief grouping',
  '## Validation Tools',
]);

const research = (replace: Record<string, string> = {}): string =>
  document(PLANNER_DOCUMENT_SECTIONS.research.map((name) => replace[name] ?? `## ${name}`));

describe('headingMatchesSection', () => {
  it.each([
    '2. Architecture',
    '**Architecture**',
    'Architecture — scope',
    'Architecture – scope',
    'Architecture - scope',
    'Architecture (the parts P01 touches)',
    'architecture: notes',
  ])('reads %s as Architecture', (heading) => {
    expect(headingMatchesSection(heading, 'Architecture')).toBe(true);
  });

  it('does not read a following word as a qualifier', () => {
    expect(headingMatchesSection('Architecture Decisions', 'Architecture')).toBe(false);
    expect(headingMatchesSection('Dependencies & Constraints', 'Dependencies')).toBe(false);
  });
});

describe('isPlannerDocument', () => {
  it('accepts the parked research reply whose headings carry qualifiers', () => {
    expect(isPlannerDocument('research', parkedResearch)).toBe(true);
  });

  it('names a section whose only heading adds a word', () => {
    const text = research({ Architecture: '## Architecture Decisions' });
    expect(isPlannerDocument('research', text)).toBe(false);
  });

  it('does not read Dependencies & Constraints as the plan Dependencies section', () => {
    const text = document(
      PLANNER_DOCUMENT_SECTIONS.plan.map((name) =>
        name === 'Dependencies' ? '## Dependencies & Constraints' : `## ${name}`,
      ),
    );
    expect(isPlannerDocument('plan', text)).toBe(false);
  });

  it('counts a heading with no body line as missing', () => {
    const text = `${research()}\n## Extra`.replace(
      '## Validation Tools\nBody line.\n',
      '## Validation Tools\n',
    );
    expect(isPlannerDocument('research', text)).toBe(false);
  });

  it('does not count a heading inside a fenced block', () => {
    const text = research({ 'Validation Tools': '```md\n## Validation Tools' }).concat('\n```\n');
    expect(isPlannerDocument('research', text)).toBe(false);
  });

  it('keeps a reply whose only heading is Questions a conversation', () => {
    expect(isPlannerDocument('research', '## Questions\nWhich module?\n')).toBe(false);
  });
});

describe('isPlannerDocument on a fenced reply', () => {
  // The shape of .splitbrief/sessions/2026-08-10-review-the-ollama-cloud-integration-with-tool/spec.md.
  const spec = document(PLANNER_DOCUMENT_SECTIONS.spec.map((name) => `## ${name}`));
  const narrated = `I'll inspect the repository.The complete \`spec.md\` content:\n\n\`\`\`md\n# Ollama Cloud Integration\n\n${spec}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\n`;

  it('reads a document the planner put inside one md fence after narration', () => {
    expect(isPlannerDocument('spec', narrated)).toBe(true);
  });

  it('reads a markdown fence', () => {
    expect(isPlannerDocument('spec', `\`\`\`markdown\n${spec}\n\`\`\``)).toBe(true);
  });

  it('does not read a fence of another language', () => {
    expect(isPlannerDocument('spec', `\`\`\`text\n${spec}\`\`\``)).toBe(false);
  });

  it('does not read a conversation as a document', () => {
    expect(isPlannerDocument('spec', 'Which module should change?')).toBe(false);
  });
});
