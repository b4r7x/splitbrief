import { describe, expect, it } from 'vitest';
import { fitFeedbackMessage } from './feedback-fit.js';

describe('fitFeedbackMessage', () => {
  it('leaves short feedback unchanged', () => {
    expect(fitFeedbackMessage('Cannot resume "alpha": missing state', 80)).toBe(
      'Cannot resume "alpha": missing state',
    );
  });

  it('leaves normal structured feedback unchanged when it fits', () => {
    expect(
      fitFeedbackMessage(
        {
          prefix: 'Cannot resume "',
          title: 'alpha',
          suffix: '": interrupted before it made progress — start it again.',
        },
        80,
      ),
    ).toBe('Cannot resume "alpha": interrupted before it made progress — start it again.');
  });

  it('truncates the quoted session title while preserving the actionable suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'prosze pokaz mi ze to dziala po prostu zrob test nic wiecej nie chce od ciebie',
        suffix: '": interrupted before it made progress — start it again.',
      },
      100,
    );

    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted).toContain('Cannot resume "prosze');
    expect(fitted).toContain('": interrupted before it made progress — start it again.');
    expect(fitted).toContain('…');
    expect(fitted).not.toContain('nie chce od ciebie');
  });

  it('truncates wide-character titles by display width while preserving the suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Session "',
        title: '功能'.repeat(8),
        suffix: '" failed without a summary to display',
      },
      55,
    );

    expect(fitted).toBe('Session "功能功能…" failed without a summary to display');
  });

  it('falls back to whole-message truncation when the suffix alone is too wide', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'very long title',
        suffix: '": interrupted before it made progress — start it again.',
      },
      24,
    );

    expect(fitted.length).toBeLessThanOrEqual(24);
    expect(fitted).toContain('…');
  });
});
