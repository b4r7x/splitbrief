import { describe, expect, it } from 'vitest';
import {
  admitCompilerCapability,
  COMPILER_SUPPORT_TABLE,
  type CompilerBackendId,
} from './compiler-capability.js';
import {
  capabilityTuple,
  conformanceProof,
} from '#testing/helpers/factories/compiler-capability.js';

describe('admitCompilerCapability', () => {
  it('admits the exact OpenCode baseline tuple with verified conformance', () => {
    const admission = admitCompilerCapability(capabilityTuple('opencode'));

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.receipt).toMatchObject({
      backend: 'opencode',
      version: '1.18.15',
      role: 'planner-read-only',
      transport: 'stdout-final',
      terminalContract: 'opencode-final-message-v1',
      containmentProfile: 'seatbelt',
      credentialChannel: 'session-copy',
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
    });
    expect(admission.receipt.capabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps the capability digest deterministic and bound to the exact tuple', () => {
    const first = admitCompilerCapability(capabilityTuple('opencode'));
    const second = admitCompilerCapability(capabilityTuple('opencode'));
    const drifted = admitCompilerCapability(
      capabilityTuple('opencode', { terminalContract: 'opencode-final-message-v2' }),
    );

    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    expect(first).toEqual(second);
    if (first.kind !== 'admitted' || second.kind !== 'admitted') return;
    expect(first.receipt.capabilityDigest).toBe(second.receipt.capabilityDigest);
    expect(drifted.kind).toBe('refused');
  });

  it('admits an exact Codex declared-file tuple with verified conformance', () => {
    const admission = admitCompilerCapability(capabilityTuple('codex'));

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.receipt.transport).toBe('declared-file');
  });
});

describe('admitCompilerCapability — absent sandbox rows', () => {
  it.each(['unavailable', 'none'])(
    'refuses containment profile "%s" with the typed capability code',
    (containmentProfile) => {
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', { containmentProfile }),
      );

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['containmentProfile']);
      expect(admission.failure.message.length).toBeGreaterThan(0);
    },
  );

  it('refuses a non-admitted launcher profile even with full conformance', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { containmentProfile: 'unknown-launcher' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['containmentProfile']);
  });
});

describe('admitCompilerCapability — role and fixture date', () => {
  it.each(['write-files', 'planner-read-write', 'implementer', ''])(
    'refuses a non-read-only role "%s" and names the role property',
    (role) => {
      const admission = admitCompilerCapability(capabilityTuple('opencode', { role }));

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['role']);
    },
  );

  it.each(['2026-08-14', '2026-08-16', '2027-01-01', ''])(
    'refuses a conformance fixture date "%s" that differs from the locked row',
    (fixtureDate) => {
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', { conformance: conformanceProof({ fixtureDate }) }),
      );

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['fixtureDate']);
    },
  );
});

describe('admitCompilerCapability — version rows', () => {
  it('admits a drifted version for a supported backend', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('claude-code', { version: '2.1.235', credentialChannel: 'session-copy' }),
    );

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.receipt.backend).toBe('claude-code');
    expect(admission.receipt.version).toBe('2.1.232');
    expect(admission.receipt.runtimeVersion).toBe('2.1.235');
    expect(admission.receipt.versionObservation).toBe('drifted');
  });

  it.each(['1.18.14', '1.18.16', '1.19.0', '1.18.15-beta.1'])(
    'admits drifted version "%s" with drift observation',
    (version) => {
      const admission = admitCompilerCapability(capabilityTuple('opencode', { version }));

      expect(admission.kind).toBe('admitted');
      if (admission.kind !== 'admitted') return;
      expect(admission.receipt.version).toBe('1.18.15');
      expect(admission.receipt.runtimeVersion).toBe(version);
      expect(admission.receipt.versionObservation).toBe('drifted');
    },
  );

  it('marks exact match as tested observation', () => {
    const admission = admitCompilerCapability(capabilityTuple('opencode', { version: '1.18.15' }));

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.receipt.version).toBe('1.18.15');
    expect(admission.receipt.runtimeVersion).toBe('1.18.15');
    expect(admission.receipt.versionObservation).toBe('tested');
  });

  it('refuses a versionRequired row that claims no runtime version', () => {
    expect(COMPILER_SUPPORT_TABLE.opencode.versionRequired).toBe(true);

    const admission = admitCompilerCapability(capabilityTuple('opencode', { version: '' }));

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
    expect(admission.missing).toEqual(['version']);
  });

  it('admits a versionless row that claims no runtime version', () => {
    expect(COMPILER_SUPPORT_TABLE.api.versionRequired).toBe(false);

    const admission = admitCompilerCapability(capabilityTuple('api'));

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.receipt.runtimeVersion).toBe('');
    expect(admission.receipt.versionObservation).toBe('tested');
  });
});

describe('admitCompilerCapability — transport rows', () => {
  it('refuses a declared-file transport for the stdout-final OpenCode row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { transport: 'declared-file' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['transport']);
  });

  it('refuses a stdout-final transport for the declared-file Codex row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('codex', { transport: 'stdout-final' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['transport']);
  });
});

describe('admitCompilerCapability — protocol rows', () => {
  it('refuses a drifted terminal contract for the OpenCode row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { terminalContract: 'opencode-final-message-v2' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['terminalContract']);
  });

  it('refuses a plain-text protocol downgrade for the Claude row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('claude-code', { terminalContract: 'plain-text' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['terminalContract']);
  });

  it('refuses an unverified terminal protocol even when every other property matches', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', {
        conformance: conformanceProof({ terminalProtocol: 'unverified' }),
      }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['conformance']);
  });
});

describe('admitCompilerCapability — credential rows', () => {
  it('refuses an api-key channel for the session-copy OpenCode row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { credentialChannel: 'api-key' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['credentialChannel']);
  });

  it('refuses a session-copy channel for the api-key-only API row', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('api', { credentialChannel: 'session-copy' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['credentialChannel']);
  });
});

describe('admitCompilerCapability — hostile-config rows', () => {
  it('refuses a combined downgrade of transport, protocol, and sandbox', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('claude-code', {
        transport: 'declared-file',
        terminalContract: 'plain-text',
        containmentProfile: 'unavailable',
      }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
    expect(admission.missing).toEqual(['transport', 'terminalContract', 'containmentProfile']);
  });

  it('refuses a claimed envelope version beyond the admitted literal', () => {
    const admission = admitCompilerCapability(capabilityTuple('opencode', { envelopeVersion: 2 }));

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['envelopeVersion']);
  });

  it('refuses a forged conformance vector even with an exact tuple', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { conformance: conformanceProof({ roleVector: 'unverified' }) }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['conformance']);
  });
});

describe('admitCompilerCapability — unsupported backend rows', () => {
  it.each(['copilot', 'aider', 'shell', 'agent'] as const)(
    'refuses %s no matter what the candidate claims',
    (backend) => {
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', {
          backend,
          version: '999.0.0',
          terminalContract: 'whatever-terminal',
        }),
      );

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['backend']);
      expect(admission.failure.message).toContain(backend);
    },
  );
});

describe('admitCompilerCapability — hostile shapes', () => {
  it('refuses an unknown backend id with the typed code and named backend property', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { backend: 'unknown-backend' as unknown as CompilerBackendId }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
    expect(admission.missing).toEqual(['backend']);
    expect(admission.failure.message).toContain('unknown-backend');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'refuses Object.prototype backend key "%s" with the typed code, never a TypeError',
    (backend) => {
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', { backend: backend as unknown as CompilerBackendId }),
      );

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['backend']);
      expect(admission.failure.message).toContain(backend);
    },
  );
});

describe('admitCompilerCapability — refusal message', () => {
  it('renders a versionless refusal without a doubled space or a dangling colon', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('api', { terminalContract: 'plain-text' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.message).toBe(
      'Compiler capability is not admitted for api: terminalContract missing or unverified.',
    );
  });

  it('appends the unsupported reason as a sentence after the claimed identity', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', {
        backend: 'shell',
        version: '',
        terminalContract: 'unsupported',
      }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.message).toBe(
      'Compiler capability is not admitted for shell: backend missing or unverified. legacy shell planner lacks compiler containment and final-response conformance.',
    );
  });

  it('keeps the claimed runtime version in the identity when one is claimed', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { transport: 'declared-file' }),
    );

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.message).toBe(
      'Compiler capability is not admitted for opencode 1.18.15: transport missing or unverified.',
    );
  });
});

describe('COMPILER_SUPPORT_TABLE', () => {
  it('stores every backend row under its own id with the locked V1 envelope version', () => {
    for (const [id, row] of Object.entries(COMPILER_SUPPORT_TABLE)) {
      expect(row.backend).toBe(id);
      expect(row.envelopeVersion).toBe(1);
    }
  });

  it('marks every versioned row versionRequired and every versionless row not', () => {
    for (const row of Object.values(COMPILER_SUPPORT_TABLE)) {
      expect(row.versionRequired).toBe(row.version !== '');
    }
  });

  it('keeps unsupported rows free of any admitted transport or channel', () => {
    for (const backend of ['copilot', 'aider', 'shell', 'agent'] as const) {
      expect(COMPILER_SUPPORT_TABLE[backend].state).toBe('unsupported');
      expect(COMPILER_SUPPORT_TABLE[backend].transports).toEqual([]);
      expect(COMPILER_SUPPORT_TABLE[backend].credentialChannels).toEqual([]);
      expect(COMPILER_SUPPORT_TABLE[backend].unsupportedReason).toBeTruthy();
    }
  });
});
