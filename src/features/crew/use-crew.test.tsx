import { Box, Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useCrew } from './use-crew.js';

function CrewProbe() {
  const crew = useCrew();
  const seats = crew.rows;
  const review = seats.find((row) => row.id === 'review');
  const source = review !== undefined && 'source' in review.seat ? review.seat.source : 'missing';

  return (
    <Box flexDirection="column">
      <Text>
        {seats.map((row) => row.id).join(',')}/{source}/{crew.verdict ?? 'no-verdict'}/
      </Text>
      {crew.presets.map((preset) => (
        <Text key={preset.id}>
          {preset.id}:{preset.notReady.join('+') || 'ready'}
        </Text>
      ))}
      <Text>signedOut:{crew.signedOut.join(',')}</Text>
    </Box>
  );
}

async function frame(): Promise<string> {
  const ui = renderFeature(<CrewProbe />);
  await flushEffects();
  const output = ui.lastFrame();
  ui.unmount();
  return output;
}

describe('useCrew', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
  });

  it('lists the seats in workflow order and points review at the planner by default', async () => {
    expect(await frame()).toContain('plan,build,review/planner/');
  });

  it('reports the review seat as its own once a reviewer is configured', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ reviewer: { kind: 'cli', tool: 'codex' } }),
    });

    expect(await frame()).toContain('/configured/');
  });

  it('surfaces the cross-lab verdict once both labs are determined', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    });

    expect(await frame()).toContain('/cross-lab/');
  });

  it('offers every ready-made crew and marks the tools not detected as ready', async () => {
    const output = await frame();

    expect(output).toContain('claude-crew-codex-review:claude-code+codex');
    expect(output).toContain('codex-crew-claude-review:codex+claude-code');
    expect(output).toContain('claude-plan-opencode-build:claude-code+opencode');
  });

  it('marks a crew ready once the tool of every seat is ready', async () => {
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    });

    const output = await frame();

    expect(output).toContain('claude-crew-codex-review:ready');
    expect(output).toContain('codex-crew-claude-review:ready');
    expect(output).toContain('claude-plan-opencode-build:opencode');
  });

  it('names installed tools that are not signed in and keeps their crews unavailable', async () => {
    detectionStore.setDetection({
      providers: [],
      cliTools: [
        cliDetectionFor('unauthenticated', 'claude-code'),
        cliDetectionFor('unauthenticated', 'codex'),
      ],
    });

    const output = await frame();

    expect(output).not.toContain(':ready');
    expect(output).toContain('signedOut:Claude Code CLI,OpenAI Codex CLI');
  });
});
