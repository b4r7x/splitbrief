import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-version.js';
import { createLineBuffer } from '../../../lib/process/line-buffer.js';
import { spawnPipe, type SpawnPipeFatalSignal } from '../../../lib/process/spawn/lifecycle.js';
import { error } from '../../../utils/error.js';
import type { SteerOutcome } from '../../calls/steering.js';
import { revalidateCliExecutableIdentity } from '../resolve-cli-executable.js';
import type {
  CliInvocation,
  CliProtocolEvent,
  CliSteeringSession,
  CliSteeringTransport,
} from './contract.js';

const STARTUP_TIMEOUT_MS = 5_000;
const INBOX_POLL_MS = 50;
const MessageResponse = z.object({ data: z.object({ id: z.string().min(1) }) });
const InboxResponse = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

export function opencodeSteeringInvocation(
  invocation: CliInvocation,
  url: string,
  password: string,
): Pick<CliSteeringSession, 'invocation' | 'credentialValues'> {
  const replaceStandalone = (args: readonly string[]) =>
    args.flatMap((arg) => (arg === '--standalone' ? ['--server', url] : [arg]));
  return {
    invocation: {
      ...invocation,
      args: replaceStandalone(invocation.args),
      ...(invocation.baseArgs !== undefined && {
        baseArgs: replaceStandalone(invocation.baseArgs),
      }),
      environment: { ...invocation.environment, OPENCODE_PASSWORD: password },
    },
    credentialValues: [password],
  };
}

export function createOpencodeSteering(
  parse: (line: string) => readonly CliProtocolEvent[],
): CliSteeringTransport {
  return {
    supportsVersion: (installedVersion) =>
      installedVersion !== undefined &&
      classifyCliAdmittedVersion({ installedVersion, minimumAdmittedVersion: '2.0.0' }) ===
        'compatible',
    open: async (input) => {
      if ((await revalidateCliExecutableIdentity(input.invocation.executable)) !== 'match') {
        throw error(
          'steering-transport-error',
          'OpenCode sidecar executable identity changed or is missing',
        );
      }
      const ready = Promise.withResolvers<Readonly<{ url: string; password: string }>>();
      const stopController = new AbortController();
      const failureController = new AbortController();
      const requestsController = new AbortController();
      const sidecarSignal = AbortSignal.any([
        stopController.signal,
        ...(input.invocation.signal === undefined ? [] : [input.invocation.signal]),
      ]);
      let stopping = false;
      let listeningUrl: string | undefined;
      let serverPassword: string | undefined;
      let started = false;
      let accepting = true;
      const pending = new Set<{
        sent: boolean;
        resolve: (outcome: SteerOutcome) => void;
      }>();
      const work = new Set<Promise<void>>();
      const closeAdmission = () => {
        if (!accepting) return;
        accepting = false;
        requestsController.abort();
        for (const item of pending) item.resolve(item.sent ? 'uncertain' : 'deferred');
        pending.clear();
      };
      const sidecarFailed = (cause: unknown) => {
        ready.reject(cause);
        closeAdmission();
        failureController.abort(cause);
      };
      const startupLines = createLineBuffer<SpawnPipeFatalSignal | undefined>(
        (line) => {
          if (started) return undefined;
          const url = line.match(/^server listening on (\S+)$/)?.[1];
          const password = line.match(/^server password (\S+)$/)?.[1];
          if (url !== undefined) {
            const address = new URL(url);
            if (
              address.protocol !== 'http:' ||
              address.hostname !== '127.0.0.1' ||
              address.port === ''
            ) {
              throw error(
                'steering-transport-error',
                'OpenCode sidecar printed an invalid loopback URL',
              );
            }
            listeningUrl = url;
          }
          if (password !== undefined) serverPassword = password;
          if (listeningUrl !== undefined && serverPassword !== undefined) {
            started = true;
            ready.resolve({ url: listeningUrl, password: serverPassword });
          }
          return undefined;
        },
        {
          maxLineBytes: 4_096,
          onOverflow: () =>
            started
              ? undefined
              : {
                  state: 'protocol-failure',
                  remediation: 'OpenCode sidecar startup line exceeded its limit',
                },
        },
      );
      const startupTimeout = setTimeout(() => {
        sidecarFailed(
          error(
            'steering-transport-error',
            'OpenCode sidecar did not print its URL and password within 5 seconds',
          ),
        );
        stopController.abort();
      }, STARTUP_TIMEOUT_MS);
      const sidecar = spawnPipe({
        command: input.invocation.executable.path,
        args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
        cwd: input.invocation.cwd,
        env: { ...input.invocation.environment },
        detached: true,
        signal: sidecarSignal,
        partialStdoutMaxBytes: 0,
        partialStderrMaxBytes: 0,
        onStdout: (chunk) => (started ? undefined : startupLines.push(chunk)),
        onStderr: () => undefined,
        onSpawned: (proc) => {
          proc.once('exit', () => {
            if (!stopping && !sidecarSignal.aborted)
              sidecarFailed(
                error(
                  'steering-transport-error',
                  'OpenCode sidecar exited before the call finished',
                ),
              );
          });
        },
        onClose: () => undefined,
      }).then(
        () => {
          if (!stopping && !sidecarSignal.aborted)
            sidecarFailed(
              error('steering-transport-error', 'OpenCode sidecar exited before the call finished'),
            );
          return { status: 'fulfilled' } as const;
        },
        (cause: unknown) => {
          if (sidecarSignal.aborted) ready.reject(cause);
          else if (!stopping) sidecarFailed(cause);
          return { status: 'rejected', cause } as const;
        },
      );
      const close = async () => {
        closeAdmission();
        stopping = true;
        clearTimeout(startupTimeout);
        stopController.abort();
        const [outcome] = await Promise.all([sidecar, Promise.all(work)]);
        if (outcome.status === 'rejected' && outcome.cause !== sidecarSignal.reason) {
          throw outcome.cause;
        }
      };

      let server: Readonly<{ url: string; password: string }>;
      try {
        server = await ready.promise;
      } catch (cause) {
        await close();
        throw cause;
      }
      clearTimeout(startupTimeout);
      const headers = {
        authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`,
        'content-type': 'application/json',
      };
      let sessionId: string | undefined;
      let admissions = Promise.resolve();
      const pollInbox = async (
        attachedSessionId: string,
        id: string,
        item: { sent: boolean; resolve: (outcome: SteerOutcome) => void },
      ) => {
        try {
          while (accepting) {
            const response = await fetch(
              `${server.url}/api/session/${encodeURIComponent(attachedSessionId)}/inbox`,
              {
                headers,
                signal: requestsController.signal,
              },
            );
            if (response.status !== 200) {
              await response.body?.cancel();
              item.resolve('uncertain');
              return;
            }
            const inbox = InboxResponse.parse(await response.json());
            if (!accepting) return;
            if (!inbox.data.some((entry) => entry.id === id)) {
              const messageResponse = await fetch(
                `${server.url}/api/session/${encodeURIComponent(attachedSessionId)}/message/${encodeURIComponent(id)}`,
                { headers, signal: requestsController.signal },
              );
              if (messageResponse.status !== 200) {
                await messageResponse.body?.cancel();
                item.resolve(messageResponse.status === 404 ? 'deferred' : 'uncertain');
                return;
              }
              const message = MessageResponse.parse(await messageResponse.json());
              if (!accepting) return;
              item.resolve(message.data.id === id ? 'delivered' : 'uncertain');
              return;
            }
            await delay(INBOX_POLL_MS, undefined, { signal: requestsController.signal });
          }
        } catch {
          item.resolve('uncertain');
        } finally {
          pending.delete(item);
        }
      };
      const track = (task: Promise<void>) => {
        work.add(task);
        void task.then(() => work.delete(task));
      };
      const send: Parameters<typeof input.onReady>[0] = (message) => {
        if (message.images !== undefined && message.images.length > 0)
          return Promise.resolve('deferred');
        if (!accepting || sessionId === undefined) return Promise.resolve('deferred');
        const attachedSessionId = sessionId;
        const delivery = Promise.withResolvers<SteerOutcome>();
        const item = { sent: false, resolve: delivery.resolve };
        pending.add(item);
        admissions = admissions.then(async () => {
          if (!accepting) return;
          item.sent = true;
          try {
            const response = await fetch(
              `${server.url}/api/session/${encodeURIComponent(attachedSessionId)}/prompt`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ text: message.text, delivery: 'steer' }),
                signal: requestsController.signal,
              },
            );
            if (response.status !== 200) {
              item.resolve('deferred');
              pending.delete(item);
              await response.body?.cancel();
              return;
            }
            const admitted = MessageResponse.parse(await response.json());
            if (accepting) track(pollInbox(attachedSessionId, admitted.data.id, item));
          } catch {
            item.resolve('uncertain');
            pending.delete(item);
          }
        });
        track(admissions);
        return delivery.promise;
      };
      return {
        ...opencodeSteeringInvocation(input.invocation, server.url, server.password),
        parse,
        failureSignal: failureController.signal,
        onAdmissionClosed: closeAdmission,
        onLine: (_line, events) => {
          if (accepting && sessionId === undefined) {
            const session = events.find((event) => event.type === 'session');
            if (session?.type === 'session') {
              sessionId = session.nativeSessionId;
              input.onReady(send);
            }
          }
          return false;
        },
        close,
      };
    },
  };
}
