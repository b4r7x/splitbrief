import { beforeEach, describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { detectionStore } from './detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';

describe('detectionStore', () => {
  beforeEach(() => {
    detectionStore.reset();
  });

  it('clones detection arrays and nested model data on ingress', () => {
    const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
    const installedVersion = cliTools[0]?.installedVersion;
    const implementers: ProviderDetection[] = [
      {
        provider: 'ollama',
        available: true,
        isLocal: true,
        models: [{ id: 'qwen', capabilities: ['tools'] }],
      },
    ];

    detectionStore.setDetection({ cliTools, implementers });
    cliTools[0]!.installedVersion = 'mutated';
    implementers[0]!.models![0]!.capabilities!.push('mutated');

    expect(detectionStore.get().cliTools[0]?.installedVersion).toBe(installedVersion);
    expect(detectionStore.get().implementers[0]?.models?.[0]?.capabilities).toEqual(['tools']);
  });

  it('clones CLI executable fingerprints and diagnostics on ingress', () => {
    const cliTools: CliToolDetection[] = [cliDetectionFor('incompatible', 'codex')];
    const produced = cliTools[0]?.diagnostic;
    const mtimeMs = cliTools[0]?.executable?.fingerprint.mtimeMs;

    detectionStore.setDetection({ cliTools, implementers: [] });
    cliTools[0]!.executable!.fingerprint.mtimeMs = 99;
    cliTools[0]!.diagnostic = { state: 'ready', remediation: null };

    expect(detectionStore.get().cliTools[0]?.executable?.fingerprint.mtimeMs).toBe(mtimeMs);
    expect(detectionStore.get().cliTools[0]?.diagnostic).toEqual(produced);
  });
});
