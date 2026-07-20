import { existsSync } from 'node:fs';
import { configPath } from '../../src/core/config/load/io.js';
import { routerStore } from '../../src/stores/navigation/router.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import {
  PTY_CHILD_EXIT_INPUT,
  PTY_CHILD_MARKER,
  PTY_CHILD_OUTPUT,
  PTY_CHILD_SCENARIO,
  PTY_CHILD_VIEWPORT,
  createSyntheticPtyProject,
  parsePtyChildArgs,
  runPtyChild,
  type PtyChildDependencies,
} from './pty/child.js';

let priorStdinIsTty: PropertyDescriptor | undefined;

beforeEach(() => {
  priorStdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
});

afterEach(() => {
  if (priorStdinIsTty) Object.defineProperty(process.stdin, 'isTTY', priorStdinIsTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('deterministic PTY child', () => {
  it('rejects unknown scenario and output values before creating a project', async () => {
    let projectCreations = 0;
    const dependencies: PtyChildDependencies = {
      createProject: () => {
        projectCreations += 1;
        throw new Error('project creation must not run');
      },
      renderApp: async () => {},
    };

    expect(() => parsePtyChildArgs(['--scenario', 'workflow-idle'])).toThrow(
      /only the home-empty scenario/,
    );
    await expect(runPtyChild(['--output', '.test-artifacts/ui'], dependencies)).rejects.toThrow(
      /only terminal output/,
    );
    expect(projectCreations).toBe(0);
  });

  it('runs the production start command on a synthetic home project without provider paths', async () => {
    let projectDir = '';
    let frame = '';
    const result = await runPtyChild(
      ['--scenario', PTY_CHILD_SCENARIO, '--output', PTY_CHILD_OUTPUT],
      {
        createProject: createSyntheticPtyProject,
        renderApp: async (app, options) => {
          projectDir = options.projectDir ?? '';
          expect(existsSync(`${projectDir}/.git`)).toBe(true);
          expect(existsSync(configPath(projectDir))).toBe(true);
          expect(routerStore.get()).toEqual({ screen: 'home' });

          const harness = renderThroughFilteredStdin(app, PTY_CHILD_VIEWPORT);
          try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            frame = harness.lastFrame() ?? '';
            harness.pressBytes(PTY_CHILD_EXIT_INPUT);
            await new Promise<void>((resolve) => setImmediate(resolve));
          } finally {
            harness.unmount();
          }
        },
      },
    );

    expect(result).toMatchObject({
      scenario: PTY_CHILD_SCENARIO,
      output: PTY_CHILD_OUTPUT,
      projectDir,
    });
    expect(frame).toContain(PTY_CHILD_MARKER);
    expect(existsSync(projectDir)).toBe(false);
  });
});
