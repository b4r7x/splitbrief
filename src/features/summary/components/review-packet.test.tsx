import { afterEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { buildReviewPacketDetailRows } from './review-packet.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function ReviewPacketRows({
  summary,
  sessionId,
  isSmall = false,
}: {
  summary: Summary;
  sessionId?: string;
  isSmall?: boolean;
}) {
  const theme = useTheme();
  const rows = buildReviewPacketDetailRows(summary, sessionId, isSmall, theme);
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

describe('buildReviewPacketDetailRows', () => {
  afterEach(() => {
    terminalSizeStore.__testReset();
  });

  it('renders nothing when no review packet rollup exists', () => {
    const ui = renderFeature(<ReviewPacketRows summary={makeSummary()} />);

    expect(ui.lastFrame() ?? '').toBe('');

    ui.unmount();
  });

  it('renders packet paths, final review status, drift and evidence status, missing artifacts, and next step', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <ReviewPacketRows
        summary={makeSummary({
          driftSummary: {
            passed: false,
            score: 0.84,
            errorCount: 0,
            warningCount: 2,
          },
          reviewPacket: {
            markdownPath: '.diptych/sessions/s1/review-packet.md',
            jsonPath: '.diptych/sessions/s1/review-packet.json',
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'written',
            driftPassed: false,
            evidenceValidatedTasks: 2,
            evidenceTotalTasks: 3,
            missingArtifactCount: 1,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Review packet');
    expect(frame).toContain('.diptych/sessions/s1/review-packet.md');
    expect(frame).toContain('.diptych/sessions/s1/review-packet.json');
    expect(frame).toContain('final review: written');
    expect(frame).toContain('drift: failed');
    expect(frame).toContain('score 0.84');
    expect(frame).toContain('2 warnings');
    expect(frame).toContain('evidence: 2/3 validated');
    expect(frame).toContain('missing artifacts: 1');
    expect(frame).toContain('next: open');
    expect(frame).toContain('checklist');

    ui.unmount();
  });

  it('renders session-local packet paths when the rollup stores artifact filenames', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <ReviewPacketRows
        sessionId="session-123"
        summary={makeSummary({
          reviewPacket: {
            markdownPath: 'review-packet.md',
            jsonPath: 'review-packet.json',
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'written',
            driftPassed: true,
            evidenceValidatedTasks: 1,
            evidenceTotalTasks: 1,
            missingArtifactCount: 0,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('.diptych/sessions/session-123/review-packet.md');
    expect(frame).toContain('.diptych/sessions/session-123/review-packet.json');

    ui.unmount();
  });

  it('renders missing and skipped packet statuses without reading packet contents', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <ReviewPacketRows
        summary={makeSummary({
          reviewPacket: {
            markdownPath: 'review-packet.md',
            jsonPath: 'review-packet.json',
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'missing',
            driftPassed: null,
            evidenceValidatedTasks: 0,
            evidenceTotalTasks: 2,
            missingArtifactCount: 2,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('final review: missing');
    expect(frame).toContain('drift: n/a');
    expect(frame).toContain('evidence: 0/2 validated');
    expect(frame).toContain('missing artifacts: 2');

    ui.unmount();
  });

  it('keeps review packet filenames visible when paths are truncated on small terminals', () => {
    const longMarkdownPath = `.diptych/sessions/${'very-long-session-id-'.repeat(5)}/review-packet.md`;
    const longJsonPath = `.diptych/sessions/${'very-long-session-id-'.repeat(5)}/review-packet.json`;
    terminalSizeStore.__testReset({ isSmall: true });

    const ui = renderFeature(
      <ReviewPacketRows
        isSmall
        summary={makeSummary({
          reviewPacket: {
            markdownPath: longMarkdownPath,
            jsonPath: longJsonPath,
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'written',
            driftPassed: true,
            evidenceValidatedTasks: 1,
            evidenceTotalTasks: 1,
            missingArtifactCount: 0,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('\u2026');
    expect(frame).toContain('review-packet.md');
    expect(frame).toContain('review-packet.json');
    expect(frame).not.toContain(longMarkdownPath);
    expect(frame).not.toContain(longJsonPath);

    ui.unmount();
  });

  it('strips terminal-control bytes from persisted packet paths before render', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <ReviewPacketRows
        summary={makeSummary({
          reviewPacket: {
            markdownPath: `.diptych/sessions/s1/review${ESC}]52;c;clip-md${BEL}-packet.md`,
            jsonPath: `.diptych/sessions/s1/review${ESC}[31m-packet.json`,
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'written',
            driftPassed: true,
            evidenceValidatedTasks: 1,
            evidenceTotalTasks: 1,
            missingArtifactCount: 0,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('.diptych/sessions/s1/review-packet.md');
    expect(frame).toContain('.diptych/sessions/s1/review-packet.json');
    expect(frame).not.toContain('clip-md');
    expect(frame).not.toContain('52;c');

    ui.unmount();
  });
});
