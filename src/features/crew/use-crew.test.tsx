import { Text } from 'ink';
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
  const seats = crew.rows.flatMap((row) => (row.kind === 'seat' ? [row] : []));
  const review = seats.find((row) => row.id === 'review');
  const source = review !== undefined && 'source' in review.seat ? review.seat.source : 'missing';

  return (
    <Text>
      {seats.map((row) => row.id).join(',')}/{source}/{crew.verdict ?? 'no-verdict'}/
      {crew.presets.map((preset) => preset.id).join(',') || 'none'}
    </Text>
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

  it('offers no preset while no tool has been detected as ready', async () => {
    expect(await frame()).toContain('/none');
  });

  it('offers only the presets whose every seat is ready', async () => {
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    });

    const output = await frame();

    expect(output).toContain('claude-crew-codex-review');
    expect(output).toContain('codex-crew-claude-review');
    expect(output).not.toContain('claude-plan-opencode-build');
  });

  it('withholds a preset whose tools are installed but not authenticated', async () => {
    detectionStore.setDetection({
      providers: [],
      cliTools: [
        cliDetectionFor('unauthenticated', 'claude-code'),
        cliDetectionFor('unauthenticated', 'codex'),
      ],
    });

    expect(await frame()).toContain('/none');
  });
});
