import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool-catalog.js';
import type { DetectCliToolsOptions } from '../../../engine/detection/detect.js';

const detectAvailableCliReadiness =
  vi.fn<(options: DetectCliToolsOptions) => Promise<readonly unknown[]>>();

vi.mock('../../../engine/detection/detect.js', () => ({
  detectAvailableCliReadiness: (options: DetectCliToolsOptions) =>
    detectAvailableCliReadiness(options),
}));

const { detectConfiguredCliReadiness } = await import('./readiness.js');

function detect(config: ReturnType<typeof makeConfig>): Promise<unknown> {
  return detectConfiguredCliReadiness({ projectDir: '/tmp/project', config, opts: {} });
}

describe('detectConfiguredCliReadiness', () => {
  beforeEach(() => {
    detectAvailableCliReadiness.mockReset();
    detectAvailableCliReadiness.mockResolvedValue([]);
  });

  it('probes nothing when no role configures a CLI tool', async () => {
    await expect(
      detect(makeConfig({ planner: { kind: 'shell', command: 'plan-it' } })),
    ).resolves.toEqual([]);
    expect(detectAvailableCliReadiness).not.toHaveBeenCalled();
  });

  it('probes only the configured CLI tools with their declared auth channels', async () => {
    await detect(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
        implementer: { kind: 'cli', tool: 'codex', authChannel: 'session' },
      }),
    );

    expect(detectAvailableCliReadiness).toHaveBeenCalledWith({
      projectDir: '/tmp/project',
      tools: ['claude-code', 'codex'],
      authChannels: { 'claude-code': 'api-key', codex: 'session' },
    });
  });

  it('probes the no-state-bridge default channel when the config omits one', async () => {
    await detect(makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }));

    expect(detectAvailableCliReadiness).toHaveBeenCalledWith({
      projectDir: '/tmp/project',
      tools: ['claude-code'],
      authChannels: { 'claude-code': defaultCliAuthChannel('claude-code').id },
    });
    expect(defaultCliAuthChannel('claude-code').id).toBe('api-key');
  });

  it('downgrades a tool to no auth channel when two roles declare conflicting channels', async () => {
    await detect(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
        implementer: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
      }),
    );

    expect(detectAvailableCliReadiness).toHaveBeenCalledWith({
      projectDir: '/tmp/project',
      tools: ['claude-code'],
      authChannels: { 'claude-code': undefined },
    });
    // The tool stays selected only because the downgraded key survives
    // Object.fromEntries with an undefined value.
    const options = detectAvailableCliReadiness.mock.calls[0]?.[0];
    expect(Object.hasOwn(options?.authChannels ?? {}, 'claude-code')).toBe(true);
  });

  it('keeps the shared channel when both roles declare the same one', async () => {
    await detect(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
        implementer: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
      }),
    );

    expect(detectAvailableCliReadiness).toHaveBeenCalledWith({
      projectDir: '/tmp/project',
      tools: ['claude-code'],
      authChannels: { 'claude-code': 'session' },
    });
  });

  it('probes every CLI tool named by an implementer profile', async () => {
    await detect(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
        implementerProfiles: {
          default: 'cheap',
          profiles: {
            cheap: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
            fallback: { kind: 'cli', tool: 'opencode' },
          },
        },
      }),
    );

    expect(detectAvailableCliReadiness).toHaveBeenCalledWith({
      projectDir: '/tmp/project',
      tools: ['claude-code', 'codex', 'opencode'],
      authChannels: {
        'claude-code': 'session',
        codex: 'api-key',
        opencode: 'provider-dependent',
      },
    });
  });
});
