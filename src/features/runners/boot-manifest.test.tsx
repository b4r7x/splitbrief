import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { FIRST_RUN_NOTE } from '../../core/discovery/copy.js';
import { glyph, spinnerFrames } from '../../lib/glyphs.js';
import { BootManifest } from './boot-manifest.js';

const CONTEXTS = { readiness: 'ctx-r', modelsDev: 'ctx-m', cliModels: 'ctx-c' };

function laneLine(frame: string, label: string): string {
  return frame.split('\n').find((line) => line.trim().endsWith(label)) ?? '';
}

describe('BootManifest', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    modelCacheStore.reset();
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }),
    });
  });

  it('shows every seat, the discovery lanes, and the spinner while cold', () => {
    detectionStore.beginRefresh({ contexts: CONTEXTS });
    const ui = renderFeature(<BootManifest />);
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');
    expect(frame).toContain(PLANNER_INHERITANCE.sentence);
    expect(frame).toContain('tools');
    expect(frame).toContain('model catalog');
    expect(frame).toContain('model lists');
    expect(spinnerFrames().some((spinner) => frame.includes(spinner))).toBe(true);
    expect(frame).toContain(FIRST_RUN_NOTE);
    expect(frame).not.toContain('models.dev');
    ui.unmount();
  });

  it('ticks a found seat to a check once detection lands', () => {
    detectionStore.setDetection({
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      providers: [],
    });
    const ui = renderFeature(<BootManifest />);
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('✓');
    ui.unmount();
  });

  it('leaves a remembered stale lane pending instead of checking it off', () => {
    detectionStore.hydrate({
      providers: [],
      cliTools: [],
      fetchedAt: 100,
      validatedAt: 100,
      generation: 0,
      requestId: 0,
      contexts: CONTEXTS,
    });
    const ui = renderFeature(<BootManifest />);
    const line = laneLine(stripAnsiStyles(ui.lastFrame()), 'tools');
    expect(line).not.toContain(glyph('check', 'unicode'));
    expect(line).toContain('·');
    ui.unmount();
  });
});
