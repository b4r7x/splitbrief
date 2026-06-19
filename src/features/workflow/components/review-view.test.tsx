import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { ReviewView } from './review-view.js';

describe('ReviewView', () => {
  let tmp: string;
  let ui: ReturnType<typeof renderFeature> | null;

  beforeEach(() => {
    resetAllStores();
    tmp = createTempDir('review-view');
    ui = null;
  });

  afterEach(() => {
    ui?.unmount();
    cleanupTempDir(tmp);
  });

  function openReviewFile(name: string, content: string) {
    const file = join(tmp, name);
    writeFileSync(file, content);
    reviewStore.setReviewFile(file);
    return file;
  }

  function codeBlock(lines: readonly string[]): string {
    return ['```txt', ...lines, '```'].join('\n');
  }

  it('uses rendered rows for narrow review scroll and footer height', async () => {
    const file = join(tmp, 'very-long-directory-name', 'nested-specification-file.md');
    mkdirSync(join(tmp, 'very-long-directory-name'));
    writeFileSync(
      file,
      [
        'This paragraph mentions src/features/workflow/components/review-view.tsx and keeps going long enough to wrap across several terminal rows.',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={8} width={24} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBeGreaterThan(1);
      expect(ui?.lastFrame()).toContain('more rows below');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('clamps an oversized review offset to the rendered document window', async () => {
    openReviewFile(
      'clamp.md',
      codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6']),
    );

    ui = renderFeature(<ReviewView height={8} width={40} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(7);
    });
    reviewStore.setScrollOffset(999);

    await vi.waitFor(() => {
      expect(reviewStore.get().scrollOffset).toBe(4);
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('line-4');
      expect(frame).toContain('line-6');
      expect(frame).toContain('↑ more');
      expect(frame).not.toContain('↓ more');
    });
  });

  it('clips a multi-line row at the review offset and keeps both scroll indicators visible', async () => {
    openReviewFile('partial-row.md', codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4']));

    ui = renderFeature(<ReviewView height={7} width={36} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(5);
    });
    reviewStore.setScrollOffset(1);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('↑ more');
      expect(frame).toContain('↓ more');
      expect(frame).not.toContain('line-0');
      expect(frame).toContain('line-1');
      expect(frame).toContain('line-2');
      expect(frame).not.toContain('line-3');
    });
  });

  it('renders review markdown headings, lists, fences, and frontmatter', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(
      file,
      [
        '---',
        'risk: HIGH',
        '---',
        '# Review Heading',
        '- keep `inline` code visible',
        '```md',
        '# not a heading',
        '- not a list',
        '```',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={18} width={48} />);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('risk: HIGH');
      expect(frame).toContain('Review Heading');
      expect(frame).toContain('• keep inline code visible');
      expect(frame).toContain('# not a heading');
      expect(frame).toContain('- not a list');
    });
  });

  it('fits wide-character file paths and strips controls from review markdown', async () => {
    const dir = join(tmp, '界語', 'deep');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'emoji-👩‍💻-e\u0301.md');
    writeFileSync(
      file,
      [
        '# Safe\u001b[31m heading\u001b[0m',
        'visible \u001b]52;c;clipboard\u0007done \u009b2Ktail',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={8} width={22} />);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('👩‍💻-e\u0301.md');
      expect(frame).toContain('Safe heading');
      expect(frame).toContain('visible done tail');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u009b');
    expect(frame).not.toContain('\u0007');
    expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 22)).toBe(true);
  });
});
