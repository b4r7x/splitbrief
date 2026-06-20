import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Composer } from '../../../src/components/composer/composer.js';
import type { RuntimeCommandDef } from '../../../src/core/runtime/commands/types.js';

const ENTER = '\r';
const UP = '\u001b[A';

function tick(ms = 0): Promise<void> {
  if (ms > 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadRuntime() {
  const React = await import('react');
  const { Box } = await import('ink');
  const { render } = await import('ink-testing-library');
  const { Composer: ComposerComponent } = await import(
    '../../../src/components/composer/composer.js'
  );
  const { initStores, teardownStores } = await import('../../../src/cli/init-stores.js');
  const { resetAllStores } = await import('../../helpers/stores.js');

  const renderComposer = (
    props: React.ComponentProps<typeof Composer>,
  ): ReturnType<typeof render> =>
    render(
      React.createElement(
        Box,
        { flexDirection: 'column', height: 12, justifyContent: 'flex-end' },
        React.createElement(ComposerComponent, props) as ReactElement,
      ),
    );

  return { initStores, teardownStores, renderComposer, resetAllStores };
}

function seedProject(projectDir: string): void {
  const diptychDir = join(projectDir, '.diptych');
  mkdirSync(diptychDir, { recursive: true });
  writeFileSync(
    join(diptychDir, 'detection-cache.json'),
    JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      planners: [],
      implementers: [],
    }),
    'utf-8',
  );
}

describe('composer input history restart flow', () => {
  it('persists workflow input on teardown and recalls it with Up after a fresh startup', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'diptych-history-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'diptych-history-project-'));
    seedProject(projectDir);
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    vi.resetModules();

    try {
      let runtime = await loadRuntime();
      runtime.resetAllStores();
      await runtime.initStores(projectDir, { allowHooks: true });
      const firstSubmissions: string[] = [];

      const firstUi = runtime.renderComposer({
        commands: [],
        currentScreen: 'workflow',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => firstSubmissions.push(text),
        onRuntimeCommand: () => {},
      });

      firstUi.stdin.write('persisted workflow prompt');
      await tick(20);
      firstUi.stdin.write(ENTER);
      await tick(20);

      expect(firstSubmissions).toEqual(['persisted workflow prompt']);
      runtime.teardownStores();
      firstUi.unmount();

      expect(readFileSync(join(tmpHome, '.diptych', 'history'), 'utf-8')).toContain(
        'persisted workflow prompt',
      );

      vi.resetModules();
      runtime = await loadRuntime();
      runtime.resetAllStores();
      await runtime.initStores(projectDir, { allowHooks: true });

      const secondUi = runtime.renderComposer({
        commands: [],
        currentScreen: 'workflow',
        mode: 'normal',
        hint: '',
        onSubmit: () => {},
        onRuntimeCommand: () => {},
      });

      secondUi.stdin.write(UP);
      await vi.waitFor(() => {
        expect(secondUi.lastFrame()).toContain('persisted workflow prompt');
      });

      runtime.teardownStores();
      secondUi.unmount();
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('composer input history screens', () => {
  it('records workflow and summary submissions and recalls them with Up', async () => {
    vi.resetModules();
    const runtime = await loadRuntime();
    runtime.resetAllStores();

    for (const screen of ['workflow', 'summary'] as const) {
      const submissions: string[] = [];
      const ui = runtime.renderComposer({
        commands: [],
        currentScreen: screen,
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submissions.push(text),
        onRuntimeCommand: () => {},
      });

      ui.stdin.write(`${screen} prompt`);
      await tick(20);
      ui.stdin.write(ENTER);
      await tick(20);
      ui.stdin.write(UP);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain(`${screen} prompt`);
      });

      expect(submissions).toEqual([`${screen} prompt`]);
      ui.unmount();
    }
  });

  it('records accepted slash-command completions outside home', async () => {
    vi.resetModules();
    const runtime = await loadRuntime();
    runtime.resetAllStores();
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/resume',
        label: 'Resume',
        description: 'Resume workflow',
        validScreens: ['home', 'workflow', 'summary'],
        handler: () => {},
      },
    ];
    const commandCalls: string[] = [];

    const ui = runtime.renderComposer({
      commands,
      currentScreen: 'summary',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: (command) => commandCalls.push(command),
    });

    ui.stdin.write('/res');
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);
    ui.stdin.write(UP);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/resume');
    });

    expect(commandCalls).toEqual(['/resume']);
    ui.unmount();
  });
});
