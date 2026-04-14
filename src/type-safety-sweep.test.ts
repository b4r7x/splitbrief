import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('type-safety sweep', () => {
  it('removes the targeted production non-null assertions', () => {
    expect(read('src/ui/input/text-editing.ts')).not.toMatch(/visualLines\[i\]!|lines\[i\]!/);
    expect(read('src/core/event-sections.ts')).not.toMatch(/events\[i\]!|taskRanges\[rangeIdx\]!/);
    expect(read('src/utils/frontmatter.ts')).not.toMatch(/lines\[i\]!|lines\[j\]!/);
    expect(read('src/components/conversation-flow/viewport-trimming.ts')).not.toMatch(/sections\[i\]!/);
  });

  it('uses explicit exhaustive guards for the updated dispatchers', () => {
    expect(read('src/engine/streaming/output-parsers.ts')).toContain('assertNever(format)');
    expect(read('src/components/workflow/sidebar.tsx')).toContain('assertNever(status)');
    expect(read('src/components/event-cards/index.tsx')).toContain('assertNever(event)');
  });

  it('removes the unsafe event renderer cast', () => {
    expect(read('src/components/event-cards/index.tsx')).not.toContain(
      "const renderer = RENDERERS[event.type] as (e: TuiEvent, ctx: RenderCtx) => ReactNode;",
    );
  });
});
