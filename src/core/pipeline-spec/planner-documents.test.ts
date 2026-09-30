import { describe, expect, it } from 'vitest';
import {
  emptyReplyContinuation,
  headingMatchesSection,
  isPlannerDocument,
  missingPlannerDocumentSections,
  PLANNER_DOCUMENT_SECTIONS,
  plannerDocumentText,
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

describe('missingPlannerDocumentSections', () => {
  it('accepts the parked research reply whose headings carry qualifiers', () => {
    expect(missingPlannerDocumentSections('research', parkedResearch)).toEqual([]);
    expect(isPlannerDocument('research', parkedResearch)).toBe(true);
  });

  it('names a section whose only heading adds a word', () => {
    const text = research({ Architecture: '## Architecture Decisions' });
    expect(missingPlannerDocumentSections('research', text)).toEqual(['Architecture']);
  });

  it('does not read Dependencies & Constraints as the plan Dependencies section', () => {
    const text = document(
      PLANNER_DOCUMENT_SECTIONS.plan.map((name) =>
        name === 'Dependencies' ? '## Dependencies & Constraints' : `## ${name}`,
      ),
    );
    expect(missingPlannerDocumentSections('plan', text)).toEqual(['Dependencies']);
  });

  it('counts a heading with no body line as missing', () => {
    const text = `${research()}\n## Extra`.replace(
      '## Validation Tools\nBody line.\n',
      '## Validation Tools\n',
    );
    expect(missingPlannerDocumentSections('research', text)).toEqual(['Validation Tools']);
  });

  it('does not count a heading inside a fenced block', () => {
    const text = research({ 'Validation Tools': '```md\n## Validation Tools' }).concat('\n```\n');
    expect(missingPlannerDocumentSections('research', text)).toContain('Validation Tools');
  });

  it('keeps a reply whose only heading is Questions a conversation', () => {
    expect(isPlannerDocument('research', '## Questions\nWhich module?\n')).toBe(false);
  });
});

describe('plannerDocumentText', () => {
  // The shape of .splitbrief/sessions/2026-08-10-review-the-ollama-cloud-integration-with-tool/spec.md.
  const spec = document(PLANNER_DOCUMENT_SECTIONS.spec.map((name) => `## ${name}`));
  const narrated = `I'll inspect the repository.The complete \`spec.md\` content:\n\n\`\`\`md\n# Ollama Cloud Integration\n\n${spec}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\n`;

  it('returns a bare document unchanged', () => {
    expect(plannerDocumentText('spec', spec)).toBe(spec);
  });

  it('unwraps a document the planner put inside one md fence after narration', () => {
    const text = plannerDocumentText('spec', narrated);
    expect(text).toBe(`# Ollama Cloud Integration\n\n${spec}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`);
    expect(isPlannerDocument('spec', narrated)).toBe(true);
  });

  it('unwraps a markdown fence', () => {
    expect(plannerDocumentText('spec', `\`\`\`markdown\n${spec}\n\`\`\``)).toBe(spec);
  });

  it('does not unwrap a fence of another language', () => {
    expect(plannerDocumentText('spec', `\`\`\`text\n${spec}\`\`\``)).toBeUndefined();
  });

  it('returns nothing for a conversation', () => {
    expect(plannerDocumentText('spec', 'Which module should change?')).toBeUndefined();
  });
});

describe('emptyReplyContinuation', () => {
  it('asks for the whole document and names the sections the reply lacks', () => {
    const text = emptyReplyContinuation('research', research({ 'Validation Tools': '## Tools' }));
    expect(text).toBe(
      `No further input: proceed with your best judgement. Return the complete research document as your whole reply, with these exact section headings: ${PLANNER_DOCUMENT_SECTIONS.research.join(', ')}. Missing or unrecognised: Validation Tools.`,
    );
  });

  it('omits the missing list when every section is there', () => {
    expect(emptyReplyContinuation('plan', 'x')).toContain('Missing or unrecognised: Summary');
    expect(emptyReplyContinuation('research', parkedResearch)).not.toContain('Missing');
  });

  it('asks for tasks.md on the tasks step', () => {
    expect(emptyReplyContinuation('tasks', 'x')).toBe(
      'No further input: proceed with your best judgement and return the complete tasks.md content as your whole reply.',
    );
  });

  it('names any other call without throwing', () => {
    expect(emptyReplyContinuation('clarify', 'x')).toBe(
      'No further input: proceed with your best judgement and return the complete clarify content as your whole reply.',
    );
  });
});
