import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killAll, launch, type LaunchedChrome, type Options } from 'chrome-launcher';
import lighthouse, {
  desktopConfig,
  generateReport,
  type Result as LighthouseResult,
} from 'lighthouse';
import {
  lighthouseAssertionViolations,
  lighthouseAuditPlan,
  LIGHTHOUSE_REPORT_DIRECTORY,
  LIGHTHOUSE_ROUTES,
  LIGHTHOUSE_RUNS_PER_ROUTE,
  type LighthouseMeasurement,
} from './lighthouse-config.js';
import { createStaticServer } from './serve-static.js';
import { OUTPUT_PATH, WEBSITE_ROOT } from './site.js';

const SERVER_HOST = '127.0.0.1';
const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];

type KillableChrome = Pick<LaunchedChrome, 'kill' | 'port'>;

type ClosableServer = {
  close(callback: (error?: Error) => void): unknown;
  readonly listening: boolean;
};

type LighthouseResources = {
  chrome: KillableChrome | undefined;
  server: ClosableServer | undefined;
};

type SignalTarget = {
  kill(processId: number, signal: NodeJS.Signals): boolean;
  readonly pid: number;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
};

export function chromeLaunchOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Options {
  const chromePath = environment.CHROME_PATH;
  return {
    chromeFlags: ['--headless=new'],
    handleSIGINT: false,
    logLevel: 'warn',
    ...(chromePath ? { chromePath } : {}),
  };
}

function closeServer(server: ClosableServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

export async function cleanupLighthouseResources(
  resources: LighthouseResources,
  killPendingChrome: () => readonly Error[] = killAll,
): Promise<void> {
  const errors: unknown[] = [];
  const chrome = resources.chrome;
  resources.chrome = undefined;
  try {
    if (chrome) {
      chrome.kill();
    } else {
      errors.push(...killPendingChrome());
    }
  } catch (error) {
    errors.push(error);
  }

  const server = resources.server;
  resources.server = undefined;
  if (server) {
    try {
      await closeServer(server);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new Error('Lighthouse resource cleanup failed', { cause: errors });
  }
}

export function installLighthouseSignalCleanup(options: {
  readonly cleanup: () => Promise<void>;
  readonly onCleanupError?: (error: unknown) => void;
  readonly signalTarget?: SignalTarget;
}): () => void {
  const signalTarget = options.signalTarget ?? process;
  const onCleanupError =
    options.onCleanupError ??
    ((error: unknown) => {
      console.error('[lighthouse] Cleanup failed:', error);
    });
  const listeners = new Map<NodeJS.Signals, () => void>();
  let handlingSignal = false;

  const uninstall = (): void => {
    for (const [signal, listener] of listeners) {
      signalTarget.removeListener(signal, listener);
    }
    listeners.clear();
  };

  for (const signal of CLEANUP_SIGNALS) {
    const listener = (): void => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      void options
        .cleanup()
        .catch(onCleanupError)
        .finally(() => {
          uninstall();
          signalTarget.kill(signalTarget.pid, signal);
        });
    };
    listeners.set(signal, listener);
    signalTarget.once(signal, listener);
  }

  return uninstall;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('Lighthouse static server did not bind to a TCP port'));
        return;
      }
      resolveListen(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, SERVER_HOST);
  });
}

function lighthouseMeasurement(result: LighthouseResult): LighthouseMeasurement {
  return {
    audits: result.audits,
    categories: result.categories,
  };
}

async function writeReports(options: {
  readonly lhr: LighthouseResult;
  readonly reportBasename: string;
  readonly reportDirectory: string;
}): Promise<void> {
  const reportPath = resolve(options.reportDirectory, options.reportBasename);
  await Promise.all([
    writeFile(`${reportPath}.report.html`, generateReport(options.lhr, 'html'), 'utf8'),
    writeFile(`${reportPath}.report.json`, `${JSON.stringify(options.lhr, null, 2)}\n`, 'utf8'),
  ]);
}

export async function runLighthouse(): Promise<void> {
  await access(resolve(OUTPUT_PATH, 'index.html'));

  const reportDirectory = resolve(WEBSITE_ROOT, LIGHTHOUSE_REPORT_DIRECTORY);
  await rm(reportDirectory, { force: true, recursive: true });
  await mkdir(reportDirectory, { recursive: true });

  const resources: LighthouseResources = {
    chrome: undefined,
    server: undefined,
  };
  const cleanup = (): Promise<void> => cleanupLighthouseResources(resources);
  const uninstallSignalCleanup = installLighthouseSignalCleanup({ cleanup });

  try {
    const server = createStaticServer({ rootDirectory: OUTPUT_PATH });
    resources.server = server;
    const serverPort = await listen(server);

    resources.chrome = await launch(chromeLaunchOptions());
    const plan = lighthouseAuditPlan(`http://${SERVER_HOST}:${serverPort}`);
    const measurements = new Map<string, LighthouseMeasurement[]>(
      LIGHTHOUSE_ROUTES.map((route) => [route, []]),
    );

    for (const audit of plan) {
      process.stdout.write(
        `[lighthouse] ${audit.route} run ${audit.runNumber}/${LIGHTHOUSE_RUNS_PER_ROUTE}\n`,
      );
      const result = await lighthouse(
        audit.url,
        {
          logLevel: 'warn',
          port: resources.chrome.port,
        },
        desktopConfig,
      );
      if (!result) {
        throw new Error(`${audit.route} run ${audit.runNumber} returned no Lighthouse result`);
      }
      if (result.lhr.runtimeError) {
        throw new Error(
          `${audit.route} run ${audit.runNumber} failed: ${result.lhr.runtimeError.message}`,
        );
      }

      await writeReports({
        lhr: result.lhr,
        reportBasename: audit.reportBasename,
        reportDirectory,
      });
      measurements.get(audit.route)?.push(lighthouseMeasurement(result.lhr));
    }

    const violations = LIGHTHOUSE_ROUTES.flatMap((route) =>
      lighthouseAssertionViolations(route, measurements.get(route) ?? []),
    );
    if (violations.length > 0) {
      throw new Error(`Lighthouse assertions failed:\n${violations.join('\n')}`);
    }

    process.stdout.write(
      `[lighthouse] ${plan.length} audits passed; reports: ${LIGHTHOUSE_REPORT_DIRECTORY}\n`,
    );
  } finally {
    uninstallSignalCleanup();
    await cleanup();
  }
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await runLighthouse();
}
