import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { ReviewView } from './review-view.js';

describe('ReviewView', () => {
  let tmp: string;
  let ui: ReturnType<typeof renderFeature> | null;

  beforeEach(() => {
    forceUnicodeGlyphs();
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

  it('renders the shared ↓ N more indicator', async () => {
    const file = join(tmp, 'very-long-directory-name', 'nested-specification-file.md');
    mkdirSync(join(tmp, 'very-long-directory-name'));
    writeFileSync(
      file,
      [
        'This paragraph mentions src/features/workflow/components/review-view.tsx and keeps going long enough to wrap across several terminal rows and then continues with many more words so the rendered output clearly overflows the available content height and forces a scroll footer to appear.',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={8} width={24} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBeGreaterThan(1);
      expect(ui?.lastFrame()).toContain('↓');
      expect(ui?.lastFrame()).toContain('more');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('clamps an oversized review offset to the rendered document window', async () => {
    openReviewFile(
      'clamp.md',
      codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6']),
    );

    ui = renderFeature(<ReviewView height={10} width={40} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(7);
    });
    reviewStore.setScrollOffset(999);

    await vi.waitFor(() => {
      expect(reviewStore.get().scrollOffset).toBe(3);
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('line-4');
      expect(frame).toContain('line-6');
      expect(frame).toContain('End of file');
      expect(frame).not.toContain('more');
    });
  });

  it('clips a multi-line row at the review offset and folds scroll affordance into one footer', async () => {
    openReviewFile('partial-row.md', codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4']));

    ui = renderFeature(<ReviewView height={8} width={36} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(5);
    });
    reviewStore.setScrollOffset(1);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).not.toContain('↑ 1 more');
      expect(frame).not.toContain('↓ 1 more');
      expect(frame).toContain('more');
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
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('risk: HIGH');
      expect(frame).toContain('Review Heading');
      expect(frame).toContain('• keep inline code visible');
      expect(frame).toContain('# not a heading');
      expect(frame).toContain('- not a list');
    });
  });

  it('spans the full content width as a bordered card', async () => {
    openReviewFile(
      'wide.md',
      [
        '# Wide Review',
        'This line should render across the full review column instead of a narrow capped column.',
      ].join('\n'),
    );

    ui = renderFeature(<ReviewView height={10} width={180} />);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('Wide Review');
      const rule = glyph('divider', 'unicode');
      const interiorRuleLine =
        frame
          .split('\n')
          .find(
            (line) => (stripAnsiStyles(line).match(new RegExp(rule, 'g')) ?? []).length === 176,
          ) ?? '';
      expect(interiorRuleLine).not.toBe('');
      expect(stripAnsiStyles(interiorRuleLine)).toContain(rule.repeat(176));
      expect(stripAnsiStyles(interiorRuleLine)).not.toContain(rule.repeat(177));
    });
  });

  it('redacts review markdown display without changing the raw file', async () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    const file = openReviewFile(
      'secret-plan.md',
      [
        '# Plan\u001b[31m Review\u001b[0m',
        `Use TOKEN=${rawToken}`,
        '```sh',
        `curl -H "Authorization: Bearer ${rawToken}"`,
        '```',
      ].join('\n'),
    );

    ui = renderFeature(<ReviewView height={10} width={80} />);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('Plan Review');
      expect(frame).toContain('TOKEN=REDACTED');
      expect(frame).toContain('Authorization: Bearer ***REDACTED***');
    });

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('\u001b');
    expect(readFileSync(file, 'utf-8')).toContain(rawToken);
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

    ui = renderFeature(<ReviewView height={8} width={24} />);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('👩‍💻-e\u0301.md');
      expect(frame).toContain('Safe heading');
      expect(frame).toContain('visible done tail');
    });

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u009b');
    expect(frame).not.toContain('\u0007');
    expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 24)).toBe(true);
  });
});
