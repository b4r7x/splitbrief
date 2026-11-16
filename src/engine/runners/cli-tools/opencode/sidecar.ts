import { createLineBuffer } from '../../../../lib/process/line-buffer.js';
import { spawnPipe } from '../../../../lib/process/spawn/lifecycle.js';
import type { SpawnPipeFatalSignal } from '../../../../lib/process/spawn/types.js';
import { error } from '../../../../utils/error.js';
import type { CliInvocation } from '../contract.js';
import { closeAdmission } from './steer-delivery.js';
import type { SidecarServer, SteeringCall } from './types.js';

const STARTUP_TIMEOUT_MS = 5_000;

/** What the startup lines of the sidecar gave so far; `started` ends the read. */
type SidecarStartup = {
  listeningUrl: string | undefined;
  serverPassword: string | undefined;
  started: boolean;
};

type SidecarExit =
  | Readonly<{ status: 'fulfilled' }>
  | Readonly<{ status: 'rejected'; cause: unknown }>;

type Sidecar = Readonly<{ startupTimeout: NodeJS.Timeout; exit: Promise<SidecarExit> }>;

function sidecarFailed(call: SteeringCall, cause: unknown): void {
  call.ready.reject(cause);
  closeAdmission(call);
  call.failureController.abort(cause);
}

function readStartupLine(call: SteeringCall, startup: SidecarStartup, line: string): undefined {
  if (startup.started) return undefined;
  const url = line.match(/^server listening on (\S+)$/)?.[1];
  const password = line.match(/^server password (\S+)$/)?.[1];
  if (url !== undefined) {
    const address = new URL(url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.port === '') {
      throw error('steering-transport-error', 'OpenCode sidecar printed an invalid loopback URL');
    }
    startup.listeningUrl = url;
  }
  if (password !== undefined) startup.serverPassword = password;
  if (startup.listeningUrl !== undefined && startup.serverPassword !== undefined) {
    startup.started = true;
    call.ready.resolve({ url: startup.listeningUrl, password: startup.serverPassword });
  }
  return undefined;
}

/** Arms the startup timeout, then spawns `opencode serve` and reads its URL and password. */
export function startSidecar(call: SteeringCall, invocation: CliInvocation): Sidecar {
  const startup: SidecarStartup = {
    listeningUrl: undefined,
    serverPassword: undefined,
    started: false,
  };
  const startupLines = createLineBuffer<SpawnPipeFatalSignal | undefined>(
    (line) => readStartupLine(call, startup, line),
    {
      maxLineBytes: 4_096,
      onOverflow: () =>
        startup.started
          ? undefined
          : {
              state: 'protocol-failure',
              remediation: 'OpenCode sidecar startup line exceeded its limit',
            },
    },
  );
  const startupTimeout = setTimeout(() => {
    sidecarFailed(
      call,
      error(
        'steering-transport-error',
        'OpenCode sidecar did not print its URL and password within 5 seconds',
      ),
    );
    call.stopController.abort();
  }, STARTUP_TIMEOUT_MS);
  const exit = spawnPipe({
    command: invocation.executable.path,
    args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    cwd: invocation.cwd,
    env: { ...invocation.environment },
    detached: true,
    signal: call.sidecarSignal,
    partialStdoutMaxBytes: 0,
    partialStderrMaxBytes: 0,
    onStdout: (chunk) => (startup.started ? undefined : startupLines.push(chunk)),
    onStderr: () => undefined,
    onSpawned: (proc) => {
      proc.once('exit', () => {
        if (!call.sidecarSignal.aborted)
          sidecarFailed(
            call,
            error('steering-transport-error', 'OpenCode sidecar exited before the call finished'),
          );
      });
    },
    onClose: () => undefined,
  }).then(
    () => {
      if (!call.sidecarSignal.aborted)
        sidecarFailed(
          call,
          error('steering-transport-error', 'OpenCode sidecar exited before the call finished'),
        );
      return { status: 'fulfilled' } as const;
    },
    (cause: unknown) => {
      if (call.sidecarSignal.aborted) call.ready.reject(cause);
      else sidecarFailed(call, cause);
      return { status: 'rejected', cause } as const;
    },
  );
  return { startupTimeout, exit };
}

/** Closes the admission, stops the sidecar, and waits for it and for the open steers. */
export async function closeSidecar(call: SteeringCall, sidecar: Sidecar): Promise<void> {
  closeAdmission(call);
  clearTimeout(sidecar.startupTimeout);
  call.stopController.abort();
  const [outcome] = await Promise.all([sidecar.exit, Promise.all(call.work)]);
  if (outcome.status === 'rejected' && outcome.cause !== call.sidecarSignal.reason) {
    throw outcome.cause;
  }
}

/** The URL and the password of the sidecar; a start that fails closes the sidecar first. */
export async function waitForServer(call: SteeringCall, sidecar: Sidecar): Promise<SidecarServer> {
  let server: SidecarServer;
  try {
    server = await call.ready.promise;
  } catch (cause) {
    await closeSidecar(call, sidecar);
    throw cause;
  }
  clearTimeout(sidecar.startupTimeout);
  return server;
}
