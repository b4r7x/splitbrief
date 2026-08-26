import { describe, it, expect } from 'vitest';
import { parseTaskManifest } from '../tasks/manifest.js';
import { buildLanguageContext } from './language-context.js';
import { buildPlanPrompt } from './plan.js';

const spec = { content: 'feature spec', hasClarifications: false };

describe('buildPlanPrompt', () => {
  it('TypeScript plan prompt keeps TypeScript examples', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('new-file.ts');
    expect(prompt).toContain('TypeScript type annotations');
  });

  it('Python plan prompt has no TypeScript references', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('python'),
    });
    expect(prompt).toContain('new-file.py');
    expect(prompt).toContain('Python type hints');
    expect(prompt).toContain('PEP 484');
    expect(prompt).not.toMatch(/TypeScript|typescript|new-file\.ts|modified-file\.ts/);
  });

  it('requests a finite host-owned manifest without provider-controlled artifacts', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('### New Files');
    expect(prompt).toContain('### Modified Files');
    expect(prompt).toContain('project-relative file exactly once');
    expect(prompt).toContain('provider-chosen pagination');
    expect(prompt).toContain('session file');
    expect(prompt).toContain('artifact path');
  });

  it('throws when the prompt exceeds the byte budget', () => {
    expect(() =>
      buildPlanPrompt({ spec, projectContext: 'x'.repeat(500), maxPromptBytes: 100 }),
    ).toThrowError(expect.objectContaining({ kind: 'task_compiler_prompt_too_large' }));
  });
});

describe('plan prompt and manifest parser share one File Structure grammar', () => {
  it('prompt requires the exact h2/h3 headings the parser accepts', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('## File Structure');
    expect(prompt).toContain('### New Files');
    expect(prompt).toContain('### Modified Files');
    expect(prompt).toContain('## Dependencies');
    expect(prompt).not.toContain('### File Structure');
  });

  it('round-trips the required sections through the parser', () => {
    const plan = `# Plan

## Summary
One-paragraph summary of the implementation approach.

## Architecture Decisions
- Key decision.

## File Structure
### New Files
- \`src/new-file.ts\`
  Purpose: describe the file's one concrete responsibility.

### Modified Files
- \`src/modified-file.ts\`
  Purpose: describe the exact existing behavior to change and why.

## Dependencies
None.

## Data Model
No new types.

## Key Implementation Details
- Details.

## Testing Strategy
- Tests.`;
    const manifest = parseTaskManifest(plan);
    expect(manifest.items.map((item) => `${item.action} ${item.file}`)).toEqual([
      'create src/new-file.ts',
      'modify src/modified-file.ts',
    ]);
  });
});
