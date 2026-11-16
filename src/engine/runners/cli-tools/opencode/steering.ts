import { isOpencode2 } from '../../../../core/runners/effort-channel.js';
import { error } from '../../../../utils/error.js';
import { revalidateCliExecutableIdentity } from '../../cli-executable/identity.js';
import type {
  CliInvocation,
  CliProtocolEvent,
  CliSteeringSession,
  CliSteeringTransport,
} from '../contract.js';
import { closeSidecar, startSidecar, waitForServer } from './sidecar.js';
import { closeAdmission, sendSteer } from './steer-delivery.js';
import type { SteeringCall } from './types.js';

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
    supportsVersion: isOpencode2,
    open: async (input) => {
      if ((await revalidateCliExecutableIdentity(input.invocation.executable)) !== 'match') {
        throw error(
          'steering-transport-error',
          'OpenCode sidecar executable identity changed or is missing',
        );
      }
      const stopController = new AbortController();
      const call: SteeringCall = {
        ready: Promise.withResolvers(),
        stopController,
        failureController: new AbortController(),
        requestsController: new AbortController(),
        sidecarSignal: AbortSignal.any([
          stopController.signal,
          ...(input.invocation.signal === undefined ? [] : [input.invocation.signal]),
        ]),
        pending: new Set(),
        work: new Set(),
        state: { accepting: true, admissions: Promise.resolve() },
      };
      const sidecar = startSidecar(call, input.invocation);
      const server = await waitForServer(call, sidecar);
      const headers = {
        authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`,
        'content-type': 'application/json',
      };
      let attached = false;
      return {
        ...opencodeSteeringInvocation(input.invocation, server.url, server.password),
        parse,
        failureSignal: call.failureController.signal,
        onAdmissionClosed: () => closeAdmission(call),
        onLine: (_line, events) => {
          if (call.state.accepting && !attached) {
            const session = events.find((event) => event.type === 'session');
            if (session?.type === 'session') {
              attached = true;
              const target = { url: server.url, headers, sessionId: session.nativeSessionId };
              input.onReady((message) => sendSteer(call, target, message));
            }
          }
          return false;
        },
        close: () => closeSidecar(call, sidecar),
      };
    },
  };
}
