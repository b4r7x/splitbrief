import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

type PtyProcess = import('node-pty').IPty;
type FixtureMode = 'off' | 'tracking';
type ChildMode = FixtureMode | 'composer';
type FailureKind = 'setup' | 'harness' | 'product';

interface Check {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface RunReport {
  readonly status: 'passed' | 'product-failed' | 'harness-failed' | 'setup-failed';
  readonly artifacts: string;
  readonly browser?: string;
  readonly checks: readonly Check[];
  readonly failures: readonly { readonly kind: FailureKind; readonly message: string }[];
}

const here = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(here, '../../../..');
const require = createRequire(import.meta.url);
const xtermScript = require.resolve('@xterm/xterm/lib/xterm.js');
const unicodeScript = require.resolve('@xterm/addon-unicode-graphemes');
const xtermStyle = require.resolve('@xterm/xterm/css/xterm.css');
const childEntrypoint = join(here, 'child.ts');
const pageScript = join(here, 'page.js');
const tsxLoader = join(repository, 'node_modules/tsx/dist/loader.mjs');
const viewport = { width: 1320, height: 620 };
const terminal = { cols: 120, rows: 32 };
const ascii = 'COPY-ME-ASCII-Alpha 123';
const multiline = ['COPY-ME-MULTI-FIRST', 'COPY-ME-MULTI-SECOND-λ漢字', 'COPY-ME-MULTI-LAST'].join(
  '\n',
);
const unicode = 'COPY-ME-UNICODE-Zażółć 日本語 😀 👩‍💻 q́';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

async function waitFor(
  description: string,
  read: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForPage(
  page: Page,
  expression: string,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function pageState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate('window.__terminalState()') as Promise<Record<string, unknown>>;
}

function childState(artifactDir: string, mode: ChildMode): Record<string, unknown> {
  return readJson(join(artifactDir, `${mode}-state.json`));
}

function spawnChild(mode: ChildMode, artifactDir: string): PtyProcess {
  const nodePty = require('node-pty') as typeof import('node-pty');
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      PATH: `${join(artifactDir, 'clipboard-bin')}:${process.env['PATH'] ?? ''}`,
      SPLITBRIEF_TEST_CLIPBOARD_FILE: join(artifactDir, 'clipboard.txt'),
      SSH_CONNECTION: '',
      TMUX: '',
      STY: '',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NODE_NO_WARNINGS: '1',
      FORCE_COLOR: '0',
      CI: 'false',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return nodePty.spawn(
    '/bin/zsh',
    [
      '-f',
      '-c',
      'exec "$@"',
      'splitbrief-terminal-test',
      process.execPath,
      '--import',
      tsxLoader,
      childEntrypoint,
      mode,
      artifactDir,
    ],
    {
      name: 'xterm-256color',
      cols: terminal.cols,
      rows: terminal.rows,
      cwd: repository,
      env: environment,
    },
  );
}

async function stopChild(child: PtyProcess): Promise<void> {
  let exited = false;
  const exit = new Promise<void>((resolveExit) => {
    const disposable = child.onExit(() => {
      exited = true;
      disposable.dispose();
      resolveExit();
    });
  });
  try {
    child.kill('SIGTERM');
  } catch {
    exited = true;
  }
  await Promise.race([exit, delay(3_000)]);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      exited = true;
    }
    await Promise.race([exit, delay(1_000)]);
  }
}

async function makePage(
  browser: Browser,
  childRef: { current: PtyProcess | undefined },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.exposeFunction('sendPtyInput', (data: string) => {
    if (childRef.current === undefined) throw new Error('PTY is not running');
    childRef.current.write(data);
  });
  await page.addStyleTag({ path: xtermStyle });
  await page.addStyleTag({
    content:
      'html,body{margin:0;width:100%;height:100%;background:#101114;color:#f0f0f0}#terminal{width:1200px;height:560px;margin:20px auto}.xterm{height:100%;padding:8px}.xterm-viewport{overflow-y:scroll}',
  });
  await page.addScriptTag({ path: xtermScript });
  await page.addScriptTag({ path: unicodeScript });
  await page.addScriptTag({ path: pageScript });
  return page;
}

async function grid(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) throw new Error('xterm screen did not render');
  return box;
}

function cellPoint(
  screen: { x: number; y: number; width: number; height: number },
  row: number,
  column: number,
): { x: number; y: number } {
  return {
    x: screen.x + (column + 0.45) * (screen.width / terminal.cols),
    y: screen.y + (row + 0.5) * (screen.height / terminal.rows),
  };
}

async function dragSelection(
  page: Page,
  prefix: string,
  endPrefix = prefix,
  reverse = false,
  duringDrag?: () => Promise<void>,
  endOffset?: number,
): Promise<void> {
  const screen = await grid(page);
  const start = (await page.evaluate(`window.__terminalFind(${JSON.stringify(prefix)})`)) as {
    row: number;
    column: number;
    viewportY: number;
  } | null;
  const end = (await page.evaluate(`window.__terminalFind(${JSON.stringify(endPrefix)})`)) as {
    row: number;
    column: number;
    length: number;
    viewportY: number;
  } | null;
  if (start === null || end === null) throw new Error(`Could not locate ${prefix}`);
  const startPoint = cellPoint(screen, start.row - start.viewportY, start.column);
  const endPoint = cellPoint(
    screen,
    end.row - end.viewportY,
    endOffset === undefined ? Math.max(0, end.length - 1) : end.column + endOffset,
  );
  const from = reverse ? endPoint : startPoint;
  const to = reverse ? startPoint : endPoint;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await delay(120);
  await duringDrag?.();
  await page.mouse.up();
  await delay(120);
}

async function wheel(
  page: Page,
  readChild: () => Record<string, unknown>,
): Promise<{
  readonly before: Record<string, unknown>;
  readonly middle: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly childBefore: Record<string, unknown>;
  readonly childMiddle: Record<string, unknown>;
  readonly childAfter: Record<string, unknown>;
}> {
  const screen = await grid(page);
  const x = screen.x + screen.width / 2;
  const y = screen.y + screen.height / 2;
  const before = await pageState(page);
  const childBefore = readChild();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -700);
  await delay(150);
  const middle = await pageState(page);
  const childMiddle = readChild();
  await page.mouse.wheel(0, 700);
  await delay(150);
  return {
    before,
    middle,
    after: await pageState(page),
    childBefore,
    childMiddle,
    childAfter: readChild(),
  };
}

async function runFixture(
  browser: Browser,
  mode: FixtureMode,
  artifactDir: string,
): Promise<{
  readonly checks: readonly Check[];
  readonly failures: readonly { kind: FailureKind; message: string }[];
}> {
  const childRef: { current: PtyProcess | undefined } = { current: undefined };
  const page = await makePage(browser, childRef);
  const checks: Check[] = [];
  const failures: { kind: FailureKind; message: string }[] = [];
  let outputWrite: Promise<unknown> = Promise.resolve();
  let ansi = '';
  try {
    const child = spawnChild(mode, artifactDir);
    childRef.current = child;
    child.onData((data) => {
      ansi += data;
      outputWrite = outputWrite
        .then(() => page.evaluate(`window.__terminalWrite(${JSON.stringify(data)})`))
        .catch(() => undefined);
    });
    await waitFor(`${mode} PTY readiness`, () => {
      try {
        return childState(artifactDir, mode)['ready'] === true;
      } catch {
        return false;
      }
    });
    await outputWrite;
    await waitForPage(
      page,
      `window.__terminalText().includes(${JSON.stringify(ascii)})`,
      `${mode} terminal output`,
    );
    const rendered = (await page.evaluate('window.__terminalText()')) as string;
    writeFileSync(join(artifactDir, `${mode}-render.txt`), rendered);
    const exactMarkersRendered = [ascii, ...multiline.split('\n'), unicode].every((value) =>
      rendered.includes(value),
    );
    checks.push({
      kind: 'pty-render',
      mode,
      exactMarkersRendered,
    });
    if (!exactMarkersRendered) throw new Error(`${mode} fixture did not render every copy marker`);

    const wheelResult = await wheel(page, () => readJson(join(artifactDir, `${mode}-state.json`)));
    await page.evaluate('window.__terminalFocus()');
    checks.push({
      kind: 'wheel',
      mode,
      viewportMoved: wheelResult.before['viewportY'] !== wheelResult.middle['viewportY'],
      ptyMouseEvents: wheelResult.childAfter['mouseEvents'],
      ptyWheelEvents: wheelResult.childAfter['wheelEvents'],
      productionScrollMoved:
        mode === 'tracking'
          ? wheelResult.childMiddle['scrollOffset'] !== wheelResult.childBefore['scrollOffset']
          : undefined,
    });
    if (
      mode === 'tracking' &&
      wheelResult.childMiddle['scrollOffset'] === wheelResult.childBefore['scrollOffset']
    ) {
      failures.push({
        kind: 'product',
        message: 'production tracking wheel reached the PTY but did not move conversation scroll',
      });
    }

    const clipboardPath = join(artifactDir, 'clipboard.txt');
    const selections = [
      { prefix: 'COPY-ME-ASCII-', expected: ascii, reverse: false },
      { prefix: 'COPY-ME-ASCII-', expected: ascii, reverse: true },
      {
        prefix: 'COPY-ME-MULTI-FIRST',
        endPrefix: 'COPY-ME-MULTI-LAST',
        expected: multiline,
        reverse: false,
      },
      { prefix: 'COPY-ME-UNICODE-', expected: unicode, reverse: false },
    ];
    for (const [index, selection] of selections.entries()) {
      await page.evaluate('window.__terminalClearSelection()');
      rmSync(clipboardPath, { force: true });
      const expected =
        mode === 'tracking' && selection.endPrefix
          ? ((await page.evaluate(
              `window.__terminalExpectedRange(${JSON.stringify(selection.prefix)}, ${JSON.stringify(selection.endPrefix)})`,
            )) as string)
          : selection.expected;
      let highlightedDuringDrag = false;
      let copiedDuringDrag = false;
      await dragSelection(
        page,
        selection.prefix,
        selection.endPrefix ?? selection.prefix,
        selection.reverse,
        async () => {
          copiedDuringDrag = existsSync(clipboardPath);
          highlightedDuringDrag = Boolean(
            await page.evaluate(
              `window.__terminalHighlighted(${JSON.stringify(selection.prefix)})`,
            ),
          );
          await page.screenshot({
            path: join(artifactDir, `${mode}-${index}-drag.png`),
            fullPage: true,
          });
        },
      );
      if (mode === 'tracking') {
        await waitFor('native copy command', () => existsSync(clipboardPath), 2_000).catch(
          () => undefined,
        );
      }
      if (mode === 'tracking') {
        await waitForPage(
          page,
          `window.__terminalHighlighted(${JSON.stringify(selection.prefix)})`,
          'released selection highlight',
          2_000,
        ).catch(() => undefined);
      }
      const state = await pageState(page);
      const highlightedAfterRelease = Boolean(
        await page.evaluate(`window.__terminalHighlighted(${JSON.stringify(selection.prefix)})`),
      );
      const copied =
        mode === 'off'
          ? ((await page.evaluate('window.__terminalCopy()')) as { eventText: string })
          : { eventText: existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '' };
      const exact =
        copied.eventText === expected &&
        (mode === 'off'
          ? state['selection'] === expected
          : highlightedDuringDrag && highlightedAfterRelease && !copiedDuringDrag);
      checks.push({
        kind: 'selection-copy',
        mode,
        reverse: selection.reverse,
        expected,
        actualSelection: state['selection'],
        copied: copied.eventText,
        highlightedDuringDrag,
        highlightedAfterRelease,
        copiedDuringDrag,
        exact,
      });
      if (!exact)
        failures.push({
          kind: mode === 'off' ? 'harness' : 'product',
          message: `${mode} drag did not highlight and copy exact text: ${JSON.stringify(expected)}`,
        });
      await page.screenshot({
        path: join(artifactDir, `${mode}-${index}-released.png`),
        fullPage: true,
      });
      if (mode === 'tracking' && index === 0) {
        writeFileSync(join(artifactDir, 'tracking-selected.ansi'), ansi);
      }
      if (mode === 'tracking') {
        if (index === 0) {
          await page.keyboard.press('Meta+c');
          await delay(120);
          const browserState = await pageState(page);
          const metaCopy = existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '';
          const stopRequests = Number(childState(artifactDir, mode)['stopRequests'] ?? 0);
          const metaExact =
            metaCopy === expected && browserState['metaCopyKeys'] === 1 && stopRequests === 0;
          checks.push({
            kind: 'browser-meta-c',
            hostClipboard: 'default action suppressed',
            copied: metaCopy,
            stopRequests,
            exact: metaExact,
          });
          if (!metaExact)
            failures.push({
              kind: 'product',
              message: 'Browser Meta+C changed copied selection or reached workflow stop',
            });
          rmSync(clipboardPath, { force: true });
          await page.evaluate('window.__terminalForwardSuperCopy()');
          await waitFor('forwarded Super+C copy', () => existsSync(clipboardPath), 2_000).catch(
            () => undefined,
          );
          const superCopy = existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '';
          const superStopped = Number(childState(artifactDir, mode)['stopRequests'] ?? 0) !== 0;
          checks.push({
            kind: 'forwarded-super-c-protocol',
            encoding: 'CSI 99;9u',
            copied: superCopy,
            stopped: superStopped,
            exact: superCopy === expected && !superStopped,
          });
          if (superCopy !== expected || superStopped)
            failures.push({
              kind: 'product',
              message: 'Forwarded Super+C did not copy the exact selection without stopping',
            });
          rmSync(clipboardPath, { force: true });
          await page.keyboard.press('Control+c');
          await waitFor('Ctrl+C copy', () => existsSync(clipboardPath), 2_000).catch(
            () => undefined,
          );
          const ctrlCopy = existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '';
          const stopped = Number(childState(artifactDir, mode)['stopRequests'] ?? 0) > 0;
          checks.push({ kind: 'selection-ctrl-c', exact: ctrlCopy === expected, stopped });
          if (stopped)
            failures.push({
              kind: 'product',
              message: 'Ctrl+C with selection reached workflow stop handler',
            });
          if (ctrlCopy !== expected)
            failures.push({ kind: 'product', message: 'Ctrl+C did not copy the active selection' });
        }
        if (index === selections.length - 1) {
          writeFileSync(join(artifactDir, 'workflow-copied.txt'), copied.eventText);
          continue;
        }
        const key = index === 1 ? 'x' : 'Escape';
        await page.keyboard.press(key);
        await delay(120);
        const cleared = !(await page.evaluate(
          `window.__terminalHighlighted(${JSON.stringify(selection.prefix)})`,
        ));
        checks.push({ kind: 'selection-clear', key, cleared });
        if (!cleared)
          failures.push({
            kind: 'product',
            message: `${key} did not clear selection highlighting`,
          });
        if (key === 'x') await page.keyboard.press('Backspace');
      }
    }
    if (mode === 'tracking') {
      const afterSelectionWheel = await wheel(page, () => childState(artifactDir, mode));
      const moved =
        afterSelectionWheel.childMiddle['scrollOffset'] !==
        afterSelectionWheel.childBefore['scrollOffset'];
      const cleared = !(await page.evaluate(`window.__terminalHighlighted('COPY-ME-UNICODE-')`));
      checks.push({ kind: 'wheel-after-selection', moved, cleared });
      if (!cleared)
        failures.push({
          kind: 'product',
          message: 'Wheel did not clear active selection highlighting',
        });
      if (!moved)
        failures.push({ kind: 'product', message: 'Wheel stopped scrolling after selection' });
    }
    if (mode === 'tracking') {
      rmSync(clipboardPath, { force: true });
      await dragSelection(
        page,
        'ASCII-Alpha',
        'ASCII-Alpha',
        false,
        async () => {
          writeFileSync(join(artifactDir, 'stream-request'), 'update');
          await waitFor(
            'workflow stream update during drag',
            () => childState(artifactDir, mode)['streamUpdates'] === 1,
          );
          await delay(100);
          await page.screenshot({
            path: join(artifactDir, 'tracking-live-drag.png'),
            fullPage: true,
          });
        },
        'ASCII-Alpha'.length - 1,
      );
      await waitFor('partial live selection copy', () => existsSync(clipboardPath), 2_000).catch(
        () => undefined,
      );
      const copied = existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '';
      await waitForPage(
        page,
        "window.__terminalText().includes('STREAM-UPDATE-VISIBLE')",
        'live output after release',
        2_000,
      ).catch(() => undefined);
      const resumed = Boolean(
        await page.evaluate("window.__terminalText().includes('STREAM-UPDATE-VISIBLE')"),
      );
      const exact = copied === 'ASCII-Alpha';
      checks.push({ kind: 'live-partial-selection', copied, exact, resumed });
      if (!exact || !resumed)
        failures.push({
          kind: 'product',
          message: 'Live drag failed exact partial copy or output did not resume after release',
        });
    }
    if (mode === 'tracking') {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+c');
      await waitFor(
        'normal workflow stop shortcut',
        () => childState(artifactDir, mode)['stopRequests'] === 1,
        2_000,
      ).catch(() => undefined);
      const stopRequests = childState(artifactDir, mode)['stopRequests'];
      checks.push({ kind: 'ctrl-c-without-selection', stopRequests, exact: stopRequests === 1 });
      if (stopRequests !== 1)
        failures.push({
          kind: 'product',
          message:
            'Ctrl+C without selection did not reach normal workflow stop handler exactly once',
        });
    }
    await page.screenshot({ path: join(artifactDir, `${mode}.png`), fullPage: true });
    await delay(150);
    const finalChildState = await childState(artifactDir, mode);
    if (mode === 'off' && Number(finalChildState['mouseEvents']) !== 0) {
      failures.push({
        kind: 'harness',
        message: 'tracking-off drag or wheel unexpectedly reached the PTY',
      });
    }
    if (mode === 'tracking' && Number(finalChildState['mouseEvents']) === 0) {
      failures.push({
        kind: 'harness',
        message: 'tracking-on drag and wheel produced no PTY mouse reports',
      });
    }
  } catch (error) {
    await page.screenshot({ path: join(artifactDir, `${mode}-failure.png`), fullPage: true });
    failures.push({
      kind: mode === 'tracking' ? 'product' : 'harness',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (childRef.current !== undefined) {
      await stopChild(childRef.current);
      childRef.current = undefined;
    }
    await outputWrite.catch(() => undefined);
    await page.close();
  }
  return { checks, failures };
}

async function runComposer(
  browser: Browser,
  artifactDir: string,
): Promise<{
  readonly checks: readonly Check[];
  readonly failures: readonly { kind: FailureKind; message: string }[];
}> {
  const childRef: { current: PtyProcess | undefined } = { current: undefined };
  const page = await makePage(browser, childRef);
  const checks: Check[] = [];
  const failures: { kind: FailureKind; message: string }[] = [];
  let outputWrite: Promise<unknown> = Promise.resolve();
  try {
    const child = spawnChild('composer', artifactDir);
    childRef.current = child;
    child.onData((data) => {
      outputWrite = outputWrite
        .then(() => page.evaluate(`window.__terminalWrite(${JSON.stringify(data)})`))
        .catch(() => undefined);
    });
    await waitFor('production Composer readiness', () => {
      try {
        return childState(artifactDir, 'composer')['ready'] === true;
      } catch {
        return false;
      }
    });
    await outputWrite;
    await page.evaluate('window.__terminalFocus()');
    const copiedPath = join(artifactDir, 'workflow-copied.txt');
    const copied = existsSync(copiedPath) ? readFileSync(copiedPath, 'utf8') : '';
    const expected = 'headless composer input λ漢字';
    const screen = await grid(page);
    await page.mouse.click(screen.x + screen.width / 2, screen.y + screen.height / 2);
    await page.keyboard.type('headless composer input ');
    await page.keyboard.insertText('λ漢字');
    await waitForPage(
      page,
      `window.__terminalText().includes(${JSON.stringify(expected)})`,
      'production Composer input echo',
    );
    await page.screenshot({ path: join(artifactDir, 'composer-draft.png'), fullPage: true });
    const clipboardPath = join(artifactDir, 'clipboard.txt');
    rmSync(clipboardPath, { force: true });
    let highlighted = false;
    await dragSelection(
      page,
      'composer input',
      'composer input',
      false,
      async () => {
        highlighted = Boolean(
          await page.evaluate("window.__terminalHighlighted('composer input')"),
        );
        await page.screenshot({
          path: join(artifactDir, 'composer-selection-drag.png'),
          fullPage: true,
        });
      },
      'composer input'.length - 1,
    );
    await waitFor('composer draft copy', () => existsSync(clipboardPath), 2_000).catch(
      () => undefined,
    );
    const draftCopy = existsSync(clipboardPath) ? readFileSync(clipboardPath, 'utf8') : '';
    const draftExact = draftCopy === 'composer input' && highlighted;
    checks.push({
      kind: 'composer-draft-selection',
      copied: draftCopy,
      highlighted,
      exact: draftExact,
    });
    if (!draftExact)
      failures.push({
        kind: 'product',
        message: 'Production composer draft did not highlight and copy exact substring',
      });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await waitFor('production Composer submission', () => {
      try {
        return readJson(join(artifactDir, 'composer-state.json'))['submitted'] !== undefined;
      } catch {
        return false;
      }
    });
    const submitted = readJson(join(artifactDir, 'composer-state.json'))['submitted'] as {
      text: string;
      images: number;
    };
    const exact = submitted.text === expected && submitted.images === 0;
    checks.push({ kind: 'production-composer', expected, submitted, exact });
    if (!exact)
      failures.push({
        kind: 'product',
        message: 'production Composer did not receive exact browser PTY text',
      });
    if (copied !== unicode) {
      failures.push({
        kind: 'product',
        message: 'Selection did not produce the exact Unicode text for paste',
      });
    } else {
      await page.evaluate(`window.__terminalPaste(${JSON.stringify(copied)})`);
      await delay(150);
      await page.keyboard.press('Enter');
      await waitFor(
        'copied text submission',
        () => {
          const submitted = childState(artifactDir, 'composer')['submitted'] as
            | { text?: string }
            | undefined;
          return submitted?.text === copied;
        },
        2_000,
      ).catch(() => undefined);
      const submitted = childState(artifactDir, 'composer')['submitted'] as
        | { text?: string }
        | undefined;
      const exact = submitted?.text === copied;
      checks.push({ kind: 'copy-paste-submit', copied, submitted, exact });
      if (!exact)
        failures.push({
          kind: 'product',
          message: 'Copied text did not paste and submit exactly through production Composer',
        });
    }
    await page.screenshot({ path: join(artifactDir, 'composer.png'), fullPage: true });
  } catch (error) {
    failures.push({
      kind: 'product',
      message: error instanceof Error ? error.message : String(error),
    });
    await page.screenshot({ path: join(artifactDir, 'composer-failure.png'), fullPage: true });
  } finally {
    if (childRef.current !== undefined) {
      await stopChild(childRef.current);
      childRef.current = undefined;
    }
    await outputWrite.catch(() => undefined);
    await page.close();
  }
  return { checks, failures };
}

export async function runTerminalBrowser(artifactsDir?: string): Promise<RunReport> {
  const artifacts = resolve(
    artifactsDir ??
      join(
        repository,
        '.test-artifacts/terminal-browser',
        new Date().toISOString().replaceAll(':', '-'),
      ),
  );
  mkdirSync(artifacts, { recursive: true });
  const clipboardBin = join(artifacts, 'clipboard-bin');
  mkdirSync(clipboardBin, { recursive: true });
  writeFileSync(join(clipboardBin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const clipboardStub = `#!${process.execPath}
const fs = require('node:fs');
const target = process.env.SPLITBRIEF_TEST_CLIPBOARD_FILE;
const text = fs.readFileSync(0);
fs.writeFileSync(target + '.' + process.pid, text);
fs.renameSync(target + '.' + process.pid, target);
`;
  for (const command of ['pbcopy', 'wl-copy', 'xclip', 'xsel', 'clip']) {
    writeFileSync(join(clipboardBin, command), clipboardStub, { mode: 0o755 });
  }
  const failures: { kind: FailureKind; message: string }[] = [];
  const checks: Check[] = [];
  let browser: Browser | undefined;
  try {
    const clipboardProbe = join(artifacts, 'clipboard-probe.txt');
    execFileSync(join(clipboardBin, 'pbcopy'), [], {
      input: 'private clipboard probe',
      env: { ...process.env, SPLITBRIEF_TEST_CLIPBOARD_FILE: clipboardProbe },
    });
    if (readFileSync(clipboardProbe, 'utf8') !== 'private clipboard probe') {
      throw new Error('Private clipboard command failed its exact stdin preflight');
    }
    rmSync(clipboardProbe);
    checks.push({
      kind: 'environment',
      shell: '/bin/zsh',
      emulator: 'xterm.js',
      clipboard: 'private native-command stdin capture',
    });
    const executable = chromium.executablePath();
    if (!existsSync(executable)) {
      failures.push({ kind: 'setup', message: `Playwright Chromium is missing at ${executable}` });
      return saveReport({ status: 'setup-failed', artifacts, checks, failures });
    }
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    const off = await runFixture(browser, 'off', artifacts);
    checks.push(...off.checks);
    failures.push(...off.failures);
    const tracking = await runFixture(browser, 'tracking', artifacts);
    checks.push(...tracking.checks);
    failures.push(...tracking.failures);
    const composer = await runComposer(browser, artifacts);
    checks.push(...composer.checks);
    failures.push(...composer.failures);
    const hasHarnessFailure = failures.some(({ kind }) => kind === 'harness');
    const hasProductFailure = failures.some(({ kind }) => kind === 'product');
    return saveReport({
      status: hasHarnessFailure
        ? 'harness-failed'
        : hasProductFailure
          ? 'product-failed'
          : 'passed',
      artifacts,
      browser: browserVersion,
      checks,
      failures,
    });
  } catch (error) {
    failures.push({
      kind: 'setup',
      message: error instanceof Error ? error.message : String(error),
    });
    return saveReport({ status: 'setup-failed', artifacts, checks, failures });
  } finally {
    await browser?.close();
  }
}

function saveReport(report: RunReport): RunReport {
  writeFileSync(
    join(report.artifacts, 'result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runTerminalBrowser();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'product-failed' ? 1 : 2;
}
