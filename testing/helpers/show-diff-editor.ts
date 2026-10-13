import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { writeConfig } from '../../src/core/config/load/io.js';
import { sessionDir } from '../../src/core/paths.js';
import { saveState } from '../../src/core/state/persistence.js';
import { createSnapshot } from '../../src/engine/snapshots/create.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../src/lib/terminal/typeahead-grace.js';
import { shellQuoteArg } from '../../src/utils/shell-quote.js';
import type { PtyExitEvent } from '../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../integration/cli/pty/run.js';
import { makeConfig } from './factories/config.js';
import { makeWorkflowState } from './factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

interface ShowDiffEditorOptions {
  readonly editor: 'cursor' | 'open';
  readonly exitCode: number;
  readonly fullscreen: boolean;
  readonly viewport: { readonly cols: number; readonly rows: number };
}

export async function mountShowDiffEditor(options: ShowDiffEditorOptions) {
  const dir = createTempDir('show-diff-editor');
  try {
    const fixture = await createFixture(dir, options);
    const result = await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          'tsx',
          '--import',
          fixture.offlinePath,
          'src/cli.ts',
          '--project',
          fixture.projectDir,
          ...(options.fullscreen ? [] : ['--no-fullscreen']),
        ],
        spawnOptions: {
          name: 'xterm-256color',
          ...options.viewport,
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: {
            ...safeChildEnvironment(fixture.home, [fixture.binDir]),
            XDG_STATE_HOME: join(dir, 'state'),
            VISUAL: `${shellQuoteArg(fixture.editorPath)} ${fixture.editorArgs.join(' ')}`,
          },
        },
      },
      async (child) => {
        const terminal = new XtermHeadless.Terminal({
          ...options.viewport,
          allowProposedApi: true,
          logLevel: 'off',
        });
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        let rawIo = '';
        const screen = () =>
          Array.from(
            { length: options.viewport.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          ).join('\n');
        const frames: string[] = [];
        const dataListener = child.onData((data) => {
          rawIo += data;
          terminal.write(data, () => frames.push(screen()));
        });
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const waitFor = async (predicate: () => boolean, label: string) => {
          const startedAt = performance.now();
          while (!predicate()) {
            if (didExit || performance.now() - startedAt >= 30_000) {
              throw new Error(`Show diff did not reach ${label}\n${screen()}`);
            }
            await delay(20);
          }
        };
        const waitForText = (text: string) => waitFor(() => screen().includes(text), text);
        const release = () => writeFileSync(fixture.releasePath, 'close');
        let disposal: Promise<void> | undefined;
        return {
          ...fixture,
          child,
          terminal,
          frames,
          screen,
          waitForText,
          waitForRedraw: async () => {
            await waitFor(() => existsSync(fixture.redrawPath), 'the editor redraw');
            if (Number(readFileSync(fixture.redrawPath, 'utf8')) === 0) {
              throw new Error('The editor redraw had no terminal listeners');
            }
            await delay(100);
          },
          rawIo: () => rawIo,
          didExit: () => didExit,
          exited: exited.promise,
          release,
          openDiff: async () => {
            await waitForText('Describe your feature');
            child.write('/sessions');
            await waitForText('/sessions');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await waitForText('Sessions · 1');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await waitForText('Ready to apply');
            child.write('\x1b[B');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            const openingAt = rawIo.length;
            child.write('\r');
            return openingAt;
          },
          unmount: () => {
            disposal ??= (async () => {
              release();
              try {
                await terminatePtyProcessGroup(child, exited.promise);
              } finally {
                dataListener.dispose();
                exitListener.dispose();
                terminal.dispose();
                cleanupTempDir(dir);
              }
            })();
            return disposal;
          },
        };
      },
    );
    if ('status' in result) throw new Error(result.reason);
    return result;
  } catch (error) {
    cleanupTempDir(dir);
    throw error;
  }
}

async function createFixture(dir: string, options: ShowDiffEditorOptions) {
  const projectDir = join(dir, 'project');
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  const binDir = join(dir, 'bin');
  const startedPath = join(dir, 'editor-started');
  const releasePath = join(dir, 'editor-release');
  const redrawPath = join(dir, 'editor-redraw');
  const sessionId = '2026-10-13-show-diff';
  for (const path of [projectDir, workspace, home, binDir]) mkdirSync(path);
  mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
  mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(projectDir, 'greeting.txt'), 'hello\n');
  writeConfig(
    projectDir,
    makeConfig({
      planner: { kind: 'shell', command: '/usr/bin/true' },
      implementer: { kind: 'agent', command: '/usr/bin/true', model: 'fixture' },
    }),
  );
  const baseline = await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  writeFileSync(join(workspace, 'greeting.txt'), 'hello from the run\n');
  saveState(
    { projectDir, sessionId },
    makeWorkflowState({
      feature: 'Inspect the greeting diff',
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: workspace,
        base: { snapshotId: baseline.manifest.id, head: null },
      },
    }),
  );
  const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
  const before = readFileSync(statePath, 'utf8');
  const editorArgs = options.editor === 'open' ? ['-W', '-t'] : ['--wait'];
  const editorScript = join(binDir, 'editor.cjs');
  writeFileSync(
    editorScript,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (JSON.stringify(args.slice(0, -1)) !== ${JSON.stringify(JSON.stringify(editorArgs))}) process.exit(1);
fs.writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify(args));
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releasePath)})) {
    clearInterval(timer);
    process.exit(${options.exitCode});
  }
}, 20);
setTimeout(() => process.exit(4), 30000).unref();
`,
  );
  const editorPath = join(binDir, options.editor);
  writeFileSync(
    editorPath,
    `#!/bin/sh\nexec ${shellQuoteArg(process.execPath)} ${shellQuoteArg(editorScript)} "$@"\n`,
    { mode: 0o755 },
  );
  const offlinePath = join(dir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    `import { existsSync, writeFileSync } from 'node:fs';
globalThis.fetch = async () => { throw new Error('Offline Show diff test'); };
const redraw = setInterval(() => {
  if (!existsSync(${JSON.stringify(startedPath)})) return;
  clearInterval(redraw);
  const listeners = process.stdout.listenerCount('resize');
  process.stdout.emit('resize');
  writeFileSync(${JSON.stringify(redrawPath)}, String(listeners));
}, 20);
redraw.unref();
`,
  );
  return {
    projectDir,
    home,
    binDir,
    startedPath,
    releasePath,
    redrawPath,
    sessionId,
    statePath,
    before,
    editorPath,
    editorArgs,
    offlinePath,
    editorStarted: () => existsSync(startedPath),
  };
}
