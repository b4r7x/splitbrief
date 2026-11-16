import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';
import { flushEffects } from '#testing/helpers/ink.js';
import type { ReactElement } from 'react';
import type { Composer } from '../../../src/components/composer/view.js';
import type { RuntimeCommandDef } from '../../../src/core/runtime/commands/types.js';

const ENTER = '\r';
const UP = '\u001b[A';

async function loadRuntime() {
  const React = await import('react');
  const { Box } = await import('ink');
  const { render } = await import('ink-testing-library');
  const { Composer: ComposerComponent } = await import('../../../src/components/composer/view.js');
  const { initStores, teardownStores } = await import('../../../src/cli/bootstrap/init.js');
  const { awaitBackgroundDiscovery } = await import('../../../src/cli/bootstrap/discovery.js');
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

  return { awaitBackgroundDiscovery, initStores, teardownStores, renderComposer, resetAllStores };
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

    // Each boot leaves the models.dev seed and the detection refresh writing
    // caches under HOME; every loaded module instance keeps its own set, so all
    // of them must settle before the fake home is removed.
    const settleDiscovery: Array<() => Promise<void>> = [];
    try {
      let runtime = await loadRuntime();
      settleDiscovery.push(runtime.awaitBackgroundDiscovery);
      runtime.resetAllStores();
      await runtime.initStores(projectDir, { allowHooks: true });
      const firstSubmissions: string[] = [];

      const firstUi = runtime.renderComposer({
        commands: [],
        currentScreen: 'workflow',
        mode: 'normal',
        hint: '',
        onSubmit: (submission) => firstSubmissions.push(submission.message.displayText),
        onRuntimeCommand: () => {},
      });
      await flushEffects();

      firstUi.stdin.write('persisted workflow prompt');
      await flushEffects();
      await vi.waitFor(() => {
        expect(firstUi.lastFrame()).toContain('persisted workflow prompt');
      });
      await flushEffects();
      firstUi.stdin.write(ENTER);
      await flushEffects();
      await vi.waitFor(() => {
        expect(firstSubmissions).toEqual(['persisted workflow prompt']);
      });
      runtime.teardownStores();
      firstUi.unmount();

      expect(readFileSync(join(tmpHome, '.splitbrief', 'history'), 'utf-8')).toContain(
        'persisted workflow prompt',
      );

      vi.resetModules();
      runtime = await loadRuntime();
      settleDiscovery.push(runtime.awaitBackgroundDiscovery);
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
      });

      runtime.teardownStores();
      secondUi.unmount();
    } finally {
      for (const settle of settleDiscovery) await settle();
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

    for (const screen of ['workflow', 'home'] as const) {
      const submissions: string[] = [];
      const ui = runtime.renderComposer({
        commands: [],
        currentScreen: screen,
        mode: 'normal',
        hint: '',
        onSubmit: (submission) => submissions.push(submission.message.displayText),
        onRuntimeCommand: () => {},
      });

      await flushEffects();
      ui.stdin.write(`${screen} prompt`);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain(`${screen} prompt`);
      });
      await flushEffects();
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(submissions).toEqual([`${screen} prompt`]);
      });
      await flushEffects();
      ui.stdin.write(UP);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain(`${screen} prompt`);
      });

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
        category: 'navigate',
        validScreens: ['home', 'workflow'],
        handler: () => {},
      },
    ];
    const commandCalls: string[] = [];

    const ui = runtime.renderComposer({
      commands,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: (command) => commandCalls.push(command),
    });

    await flushEffects();
    ui.stdin.write('/res');
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('Resume workflow');
    });
    await flushEffects();
    ui.stdin.write(ENTER);
    // The accept must both dispatch and close the menu before Up is pressed —
    // while the menu is still open, Up moves its selection instead of history.
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/resume']);
      expect(ui.lastFrame()).not.toContain('Resume workflow');
    });
    await flushEffects();
    ui.stdin.write(UP);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/resume');
    });
    ui.unmount();
  });
});
