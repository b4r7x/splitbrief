import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliOutputContract,
  CliPlannerAdapter,
  CliProbeContract,
  CliPromptTransport,
  CliProtocolEvent,
} from './contract.js';

const probe = {
  version: {
    command: ['fixture', '--version'],
    cwd: 'neutral',
    timeoutMs: 1_000,
    maxOutputBytes: 8_192,
  },
  auth: {
    command: ['fixture', 'auth', 'status'],
    cwd: 'neutral',
    timeoutMs: 1_000,
    maxOutputBytes: 8_192,
  },
} as const satisfies CliProbeContract;

const terminalResult = {
  type: 'result',
  status: 'completed',
  text: '',
  usage: null,
  nativeSessionId: null,
  error: null,
  partial: false,
} as const satisfies CliProtocolEvent;

const adapterMembers = {
  descriptor: CLI_TOOL_CATALOG.codex,
  promptTransport: { kind: 'stdin' },
  validateArgs: () => ({ valid: true as const }),
  environment: {},
  outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
  parse: () => [],
  terminal: () => terminalResult,
  probe,
} as const;

const plannerAdapter = {
  ...adapterMembers,
  role: 'planner',
  buildArgs: ({ prompt }) => ['plan', prompt],
} satisfies CliPlannerAdapter<'codex'>;

const implementerAdapter = {
  ...adapterMembers,
  role: 'implementer',
  buildArgs: ({ prompt }) => ['implement', prompt],
} satisfies CliImplementerAdapter<'codex'>;

const wrongDescriptorAdapter = {
  ...plannerAdapter,
  descriptor: CLI_TOOL_CATALOG.aider,
};

// @ts-expect-error The adapter's tool parameter must match its catalog descriptor.
const mismatchedDescriptor: CliPlannerAdapter<'codex'> = wrongDescriptorAdapter;

describe('CLI adapter contract', () => {
  it('models stdin, bounded lossless argv, and private-file prompt transports', () => {
    const transports = [
      { kind: 'stdin' },
      { kind: 'argv', maxBytes: 120_000 },
      { kind: 'file', mode: 0o600 },
    ] as const satisfies readonly CliPromptTransport[];

    expect(transports).toEqual([
      { kind: 'stdin' },
      { kind: 'argv', maxBytes: 120_000 },
      { kind: 'file', mode: 0o600 },
    ]);
  });

  it('distinguishes protocol-terminal output from process-exit text output', () => {
    const contracts = [
      { kind: 'structured-terminal', terminalEvent: 'required' },
      { kind: 'text-exit', successfulExitCodes: [0] },
    ] as const satisfies readonly CliOutputContract[];

    expect(contracts.map((contract) => contract.kind)).toEqual([
      'structured-terminal',
      'text-exit',
    ]);
  });

  it('keeps invocation transport, environment, cancellation, and limits explicit', () => {
    const invocation = {
      executable: {
        path: '/usr/local/bin/fixture',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      },
      args: ['run'],
      promptTransport: { kind: 'stdin' },
      environment: { FIXTURE_MODE: 'test' },
      cwd: '/tmp/project',
      timeoutMs: 30_000,
      signal: undefined,
    } satisfies CliInvocation;

    expect(invocation.promptTransport.kind).toBe('stdin');
    expect(invocation.executable.path).toBe('/usr/local/bin/fixture');
    expect(invocation.timeoutMs).toBe(30_000);
  });

  it('requires role-specific adapters to own argument and process policies', () => {
    expect(plannerAdapter.role).toBe('planner');
    expect(implementerAdapter.role).toBe('implementer');
    expect(plannerAdapter.descriptor).toBe(CLI_TOOL_CATALOG.codex);
    expect(implementerAdapter.descriptor.modelPolicy.implementer).toBe('optional');
    expect(plannerAdapter.probe).toBe(probe);
    expect(implementerAdapter.outputContract.kind).toBe('structured-terminal');
  });

  it('rejects adapters missing terminal, probe, or transport ownership', () => {
    const { terminal: _terminal, ...missingTerminal } = plannerAdapter;
    // @ts-expect-error Adapters must declare how a call reaches a terminal result.
    const plannerWithoutTerminal: CliPlannerAdapter = missingTerminal;

    const { probe: _probe, ...missingProbe } = implementerAdapter;
    // @ts-expect-error Adapters must own bounded version and authentication probes.
    const implementerWithoutProbe: CliImplementerAdapter = missingProbe;

    const { promptTransport: _promptTransport, ...missingTransport } = plannerAdapter;
    // @ts-expect-error Adapters must choose a lossless prompt transport.
    const plannerWithoutTransport: CliPlannerAdapter = missingTransport;

    const { descriptor: _descriptor, ...missingDescriptor } = implementerAdapter;
    // @ts-expect-error Adapters must bind to a real catalog descriptor.
    const implementerWithoutDescriptor: CliImplementerAdapter = missingDescriptor;

    expect('terminal' in plannerWithoutTerminal).toBe(false);
    expect('probe' in implementerWithoutProbe).toBe(false);
    expect('promptTransport' in plannerWithoutTransport).toBe(false);
    expect('descriptor' in implementerWithoutDescriptor).toBe(false);
    expect(mismatchedDescriptor.descriptor.id).toBe('aider');
  });
});
