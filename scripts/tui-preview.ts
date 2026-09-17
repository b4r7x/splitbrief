import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { withFullScreen } from 'fullscreen-ink';
import { createElement } from 'react';
import {
  formatViewport,
  ViewportSchema,
  type Viewport,
} from '../testing/visual/contracts/geometry.js';
import { listVisualScenarios, VISUAL_CATALOG_VERSION } from '../testing/visual/catalog.js';
import { createFilteredStdin } from '../src/lib/terminal/filtered-stdin/create.js';
import { setActiveFilteredStdin } from '../src/lib/terminal/filtered-stdin/active.js';
import { PreviewView } from '../testing/visual/preview/view.js';
import { createPreviewController } from '../testing/visual/preview/controller.js';

interface PreviewCliOptions {
  readonly list: boolean;
  readonly scenario: string | undefined;
  readonly help: boolean;
}

function parseArguments(args: readonly string[]): PreviewCliOptions {
  let list = false;
  let scenario: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--list') {
      list = true;
      continue;
    }
    if (argument === '--scenario') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('--scenario needs an ID');
      scenario = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { list: false, scenario, help: true };
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { list, scenario, help: false };
}

function printHelp(): void {
  process.stdout.write(
    [
      'tui-preview — interact with one deterministic visual gallery scenario',
      '',
      '  npm run tui-preview',
      '  npm run tui-preview -- --scenario home-empty',
      '  npm run tui-preview -- --list',
      '',
    ].join('\n'),
  );
}

function printCatalog(): void {
  process.stdout.write(`visual catalog v${VISUAL_CATALOG_VERSION}\n`);
  for (const scenario of listVisualScenarios()) {
    process.stdout.write(
      `${scenario.id}\t${scenario.title}\tviewports=${scenario.viewports.map(formatViewport).join(',')}\telements=${scenario.elements.map((element) => element.id).join(',')}\n`,
    );
  }
}

function terminalViewport(): Viewport {
  return ViewportSchema.parse({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });
}

function createInputProxy(source: NodeJS.ReadStream): NodeJS.ReadStream {
  const proxy = new PassThrough();
  Object.defineProperty(proxy, 'isTTY', {
    configurable: true,
    enumerable: true,
    get: () => source.isTTY,
  });
  Object.assign(proxy, {
    setRawMode(mode: boolean): PassThrough {
      source.setRawMode(mode);
      return proxy;
    },
    ref(): PassThrough {
      source.ref();
      return proxy;
    },
    unref(): PassThrough {
      source.unref();
      return proxy;
    },
  });
  // Interop boundary: Ink reads TTY members from this stream, while the controller owns the
  // source listener so F2/F5/F6/Ctrl+Q can be consumed before bytes reach the preview.
  return proxy as unknown as NodeJS.ReadStream;
}

async function runTuiPreview(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArguments(args);
    if (options.help) {
      printHelp();
      return 0;
    }
    if (options.list) {
      printCatalog();
      return 0;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('tui-preview requires an interactive terminal\n');
      return 1;
    }

    const inputProxy = createInputProxy(process.stdin);
    const filtered = createFilteredStdin(inputProxy, {
      activate: false,
      mouse: true,
      hover: false,
    });
    let fullscreen: ReturnType<typeof withFullScreen> | undefined;
    const controller = createPreviewController({
      scenarios: listVisualScenarios(),
      hostViewport: terminalViewport(),
      forward: (input) => inputProxy.write(input),
      onQuit: () => fullscreen?.instance.unmount(),
    });
    setActiveFilteredStdin(filtered);
    const detachInput = controller.attachInput(process.stdin);
    const onResize = () => {
      void controller.resizeHost(terminalViewport());
    };
    process.stdout.on('resize', onResize);

    try {
      fullscreen = withFullScreen(createElement(PreviewView, { controller }), {
        stdin: filtered.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await fullscreen.start();
      filtered.activate();
      if (options.scenario !== undefined) await controller.selectScenario(options.scenario);
      await fullscreen.waitUntilExit();
      return 0;
    } finally {
      process.stdout.off('resize', onResize);
      detachInput();
      fullscreen?.instance.unmount();
      if (fullscreen !== undefined) await fullscreen.waitUntilExit().catch(() => {});
      filtered.disable();
      setActiveFilteredStdin(undefined);
      await controller.dispose();
    }
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  process.exitCode = await runTuiPreview();
}

export { runTuiPreview };
