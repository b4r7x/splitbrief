import { beforeEach, describe, expect, it } from 'vitest';
import { detectionStore } from './detection.js';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';

describe('detectionStore', () => {
  beforeEach(() => {
    detectionStore.reset();
  });

  it('clones detection arrays and nested model data on ingress', () => {
    const planners: PlannerDetection[] = [
      {
        tool: 'claude-code',
        type: 'cli',
        available: true,
        version: '1.0.0',
      },
    ];
    const implementers: ProviderDetection[] = [
      {
        provider: 'ollama',
        available: true,
        isLocal: true,
        models: [{ id: 'qwen', capabilities: ['tools'] }],
      },
    ];

    detectionStore.setDetection({ planners, implementers });
    planners[0]!.version = 'mutated';
    implementers[0]!.models![0]!.capabilities!.push('mutated');

    expect(detectionStore.get().planners[0]?.version).toBe('1.0.0');
    expect(detectionStore.get().implementers[0]?.models?.[0]?.capabilities).toEqual(['tools']);
  });

  it('clones planner compatibility on ingress', () => {
    const planners: PlannerDetection[] = [
      {
        tool: 'codex',
        type: 'cli',
        available: true,
        version: '9.0.0',
        compatibility: {
          kind: 'major-version-mismatch',
          installedVersion: '9.0.0',
          testedVersion: '0.40.0',
        },
      },
    ];

    detectionStore.setDetection({ planners, implementers: [] });
    planners[0]!.compatibility!.installedVersion = 'mutated';

    expect(detectionStore.get().planners[0]?.compatibility).toEqual({
      kind: 'major-version-mismatch',
      installedVersion: '9.0.0',
      testedVersion: '0.40.0',
    });
  });
});
