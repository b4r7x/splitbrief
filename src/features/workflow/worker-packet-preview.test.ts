import { describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import type { RoutingDecision } from '../../engine/orchestrator/context-routing.js';
import type { PlanTaskReviewMetadata } from '../../stores/workflow/plan-editor.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildWorkerPacketPreview } from './worker-packet-preview.js';

describe('buildWorkerPacketPreview', () => {
  it('returns null when no task is selected', () => {
    expect(buildWorkerPacketPreview({ task: undefined, context: defaultContext })).toBeNull();
  });

  it('builds visible packet text from the real formatter and review metadata', () => {
    const task = makeTask({
      title: 'Update parser',
      file: 'src/parser.ts',
      tests: ['parses quoted values'],
    });
    const metadata: PlanTaskReviewMetadata = {
      taskId: task.id,
      workerProfile: 'local-qwen',
      selectedCostTier: 'local',
      contextFit: 'fits',
      estimatedTokens: 1200,
      contextLength: 8192,
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, metadata });

    expect(preview?.workerProfile).toBe('local-qwen');
    expect(preview?.costTier).toBe('local');
    expect(preview?.contextFit).toBe('fits');
    expect(preview?.estimatedTokens).toBe(1200);
    expect(preview?.contextLength).toBe(8192);
    expect(preview?.routingPending).toBe(false);
    expect(preview?.refreshRequired).toBe(false);
    expect(preview?.visibleSystemPreamble).toContain('SYSTEM:');
    expect(preview?.visibleTaskPrompt).toContain('## Task: Update parser');
    expect(preview?.visibleTaskPrompt).toContain('### Tests');
    expect(preview?.visibleTaskPrompt).toContain('- parses quoted values');
  });

  it('can route from config and expose selected worker, cost tier, and write modes', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'src/sidecar.ts'] },
    });
    const config: Config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'local-api',
        profiles: {
          'agent-worker': {
            kind: 'agent',
            command: 'agent-worker',
            model: 'agent-worker',
            contextLength: 20_000,
            costTier: 'standard',
          },
          'local-api': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'local-api',
            contextLength: 20_000,
            costTier: 'local',
          },
        },
      },
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, config });

    expect(preview?.workerProfile).toBe('agent-worker');
    expect(preview?.costTier).toBe('standard');
    expect(preview?.requiredWriteMode).toBe('direct');
    expect(preview?.selectedWriteMode).toBe('direct');
    expect(preview?.contextFit).toBe('fits');
  });

  it('prefers review metadata over rerouting from config to avoid stale prompt divergence', () => {
    const task = makeTask({
      file: 'src/main.ts',
      currentCode: 'export const stale = true;',
      scope: { inBounds: ['src/main.ts', 'src/sidecar.ts'] },
    });
    const metadata: PlanTaskReviewMetadata = {
      taskId: task.id,
      workerProfile: 'local-qwen',
      selectedCostTier: 'local',
      contextFit: 'fits',
      estimatedTokens: 1500,
      contextLength: 32768,
    };
    const config: Config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'local-api',
        profiles: {
          'agent-worker': {
            kind: 'agent',
            command: 'agent-worker',
            model: 'agent-worker',
            contextLength: 20_000,
            costTier: 'standard',
          },
          'local-api': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'local-api',
            contextLength: 20_000,
            costTier: 'local',
          },
        },
      },
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, metadata, config });

    expect(preview?.workerProfile).toBe('local-qwen');
    expect(preview?.costTier).toBe('local');
    expect(preview?.requiredWriteMode).toBeUndefined();
    expect(preview?.notices.join(' ')).toContain('Using review metadata');
  });

  it('does not mark overflow no-capable metadata as routing pending when review routing is complete', () => {
    const task = makeTask({
      file: 'src/large.ts',
      currentCode: 'export const large = true;',
      action: 'modify',
    });
    const metadata: PlanTaskReviewMetadata = {
      taskId: task.id,
      contextFit: 'overflow',
      estimatedTokens: 45_000,
      contextLength: 32_768,
      routingReason: 'No capable implementer profile can fit this task prompt',
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, metadata });

    expect(preview?.workerProfile).toBeUndefined();
    expect(preview?.contextFit).toBe('overflow');
    expect(preview?.routingPending).toBe(false);
    expect(preview?.notices.join(' ')).not.toContain('Routing metadata is pending');
  });

  it('prefers routing-decision current-code mode and token fields when provided', () => {
    const task = makeTask({
      id: 'T099',
      action: 'modify',
      currentCode: 'export function run() { return "old"; }',
      signature: 'export function run(): string',
    });
    const decision: RoutingDecision = {
      taskId: task.id,
      selectedProfile: 'cheap-worker',
      selectedCostTier: 'cheap',
      selectedWriteMode: 'extracted-code',
      requiredWriteMode: 'extracted-code',
      fit: 'tight',
      estimatedTokens: 900,
      untruncatedEstimatedTokens: 1900,
      contextLength: 1024,
      currentCodeTruncated: false,
      currentCodeContextMode: 'function-level',
      costPosture: 'Selected cheap cost tier',
      reason: 'Selected cheap-worker',
      rejected: [],
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, routingDecision: decision });

    expect(preview?.workerProfile).toBe('cheap-worker');
    expect(preview?.contextFit).toBe('tight');
    expect(preview?.estimatedTokens).toBe(900);
    expect(preview?.untruncatedEstimatedTokens).toBe(1900);
    expect(preview?.currentCodeContextMode).toBe('function-level');
  });

  it('infers current-code mode from formatted modify prompts when routing mode is unavailable', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function hello() { return "old"; }',
      signature: 'export function hello(): string',
    });

    const preview = buildWorkerPacketPreview({ task, context: defaultContext });

    expect(preview?.currentCodeContextMode).toBe('whole-file');
    expect(preview?.visibleTaskPrompt).toContain('### Current Code');
  });

  it('redacts secret-looking values from the visible prompt without removing section shape', () => {
    const task = makeTask({
      description: [
        'Wire the client using API_KEY=sk-supersecret123456 and Authorization: Bearer abc.def.ghi',
        'Use postgres://user:password@example.com/app for the example.',
      ].join('\n'),
      currentCode: [
        'const password = "hunter2";',
        'const token = "ghp_abcdefghijklmnopqrstuvwxyz";',
      ].join('\n'),
      action: 'modify',
    });

    const preview = buildWorkerPacketPreview({ task, context: defaultContext });

    expect(preview?.redacted).toBe(true);
    expect(preview?.taskPromptRedacted).toBe(true);
    expect(preview?.visibleTaskPrompt).toContain('### Description');
    expect(preview?.visibleTaskPrompt).toContain('[REDACTED]');
    expect(preview?.visibleTaskPrompt).not.toContain('sk-supersecret123456');
    expect(preview?.visibleTaskPrompt).not.toContain('abc.def.ghi');
    expect(preview?.visibleTaskPrompt).not.toContain('user:password@example.com');
    expect(preview?.visibleTaskPrompt).not.toContain('hunter2');
    expect(preview?.visibleTaskPrompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });

  it('exposes stale metadata and omits stale current code when review could not refresh it', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const staleSecret = "should not render";',
    });
    const metadata: PlanTaskReviewMetadata = {
      taskId: task.id,
      workerProfile: 'local-qwen',
      selectedCostTier: 'local',
      contextFit: 'fits',
      estimatedTokens: 1100,
      contextLength: 8192,
      estimateStatus: 'missing-current-code',
      stale: true,
      checkpoint: 'pre-review',
      conflict: { kind: 'current-task-conflict', files: ['src/hello.ts'] },
    };

    const preview = buildWorkerPacketPreview({ task, context: defaultContext, metadata });

    expect(preview?.estimateStatus).toBe('missing-current-code');
    expect(preview?.stale).toBe(true);
    expect(preview?.checkpoint).toBe('pre-review');
    expect(preview?.conflict?.kind).toBe('current-task-conflict');
    expect(preview?.refreshRequired).toBe(true);
    expect(preview?.visibleTaskPrompt).not.toContain('should not render');
    expect(preview?.currentCodeContextMode).toBe('none');
    expect(preview?.notices.join(' ')).toContain('refresh before trusting dispatch readiness');
  });

  it('marks display truncation without changing token estimates', () => {
    const task = makeTask({
      description: 'Long task text. '.repeat(80),
    });

    const preview = buildWorkerPacketPreview({
      task,
      context: defaultContext,
      display: { maxPromptChars: 240 },
    });

    expect(preview?.truncated).toBe(true);
    expect(preview?.taskPromptTruncated).toBe(true);
    expect(preview?.visibleTaskPrompt).toContain('[... display truncated ...]');
    expect(preview?.estimatedTokens).toBeGreaterThan(0);
    expect(preview?.untruncatedEstimatedTokens).toBeGreaterThan(0);
    expect(preview?.notices.join(' ')).toContain('display-truncated');
  });
});
