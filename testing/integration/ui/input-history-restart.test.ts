import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';
import { flushEffects } from '#testing/helpers/ink.js';
import type { ReactElement } from 'react';
import type { Composer } from '../../../src/components/composer/composer.js';
import type { RuntimeCommandDef } from '../../../src/core/runtime/commands/types.js';

const ENTER = '\r';
const UP = '\u001b[A';

// React/Ink commits (typed text, completion menu open/close) can outlive a fixed
// 20ms tick and vi.waitFor's 1s default under full-suite load; every step waits
// on its observable outcome instead, with the same headroom home.test.tsx uses.
const COMPOSER_WAIT_MS = 5000;

async function loadRuntime() {
  const React = await import('react');
  const { Box } = await import('ink');
  const { render } = await import('ink-testing-library');
  const { Composer: ComposerComponent } = await import(
    '../../../src/components/composer/composer.js'
  );
  const { initStores, teardownStores } = await import('../../../src/cli/init-stores.js');
  const { resetAllStores } = await import('#testing/helpers/stores.js');

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
  writeEmptyDetectionCache(projectDir);
}

setupFetchMock();

describe('composer input history restart flow', () => {
  it('persists workflow input on teardown and recalls it with Up after a fresh startup', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'splitbrief-history-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-history-project-'));
    seedProject(projectDir);
    const originalHome = process.env['HOME'];
    const originalPath = process.env['PATH'];
    const emptyBinDir = join(tmpHome, 'bin');
    mkdirSync(emptyBinDir);
    process.env['HOME'] = tmpHome;
    process.env['PATH'] = emptyBinDir;
    vi.resetModules();
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));

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
      await flushEffects();

      firstUi.stdin.write('persisted workflow prompt');
      await flushEffects();
      await vi.waitFor(() => {
        expect(firstUi.lastFrame()).toContain('persisted workflow prompt');
      }, COMPOSER_WAIT_MS);
      await flushEffects();
      firstUi.stdin.write(ENTER);
      await flushEffects();
      await vi.waitFor(() => {
        expect(firstSubmissions).toEqual(['persisted workflow prompt']);
      }, COMPOSER_WAIT_MS);
      runtime.teardownStores();
      firstUi.unmount();

      expect(readFileSync(join(tmpHome, '.splitbrief', 'history'), 'utf-8')).toContain(
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
      await flushEffects();

      secondUi.stdin.write(UP);
      await flushEffects();
      await vi.waitFor(() => {
        expect(secondUi.lastFrame()).toContain('persisted workflow prompt');
      }, COMPOSER_WAIT_MS);

      runtime.teardownStores();
      secondUi.unmount();
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
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

      await flushEffects();
      ui.stdin.write(`${screen} prompt`);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain(`${screen} prompt`);
      }, COMPOSER_WAIT_MS);
      await flushEffects();
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(submissions).toEqual([`${screen} prompt`]);
      }, COMPOSER_WAIT_MS);
      await flushEffects();
      ui.stdin.write(UP);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain(`${screen} prompt`);
      }, COMPOSER_WAIT_MS);

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

    await flushEffects();
    ui.stdin.write('/res');
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('Resume workflow');
    }, COMPOSER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    // The accept must both dispatch and close the menu before Up is pressed —
    // while the menu is still open, Up moves its selection instead of history.
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/resume']);
      expect(ui.lastFrame()).not.toContain('Resume workflow');
    }, COMPOSER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(UP);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/resume');
    }, COMPOSER_WAIT_MS);
    ui.unmount();
  });
});
