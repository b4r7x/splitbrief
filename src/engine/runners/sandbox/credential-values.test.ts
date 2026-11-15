import { describe, expect, it } from 'vitest';
import {
  attachSandboxCredentialValues,
  credentialValuesFromEnvironment,
  SANDBOX_CREDENTIAL_VALUES,
  sandboxCredentialValues,
} from './credential-values.js';

describe('credentialValuesFromEnvironment', () => {
  it('reads each credential once: credential names, declared channel names, sandbox values', () => {
    const environment: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'openai-canary-4b1e',
      TOOL_LOGIN: 'declared-canary-77d0',
      DECLARED_EMPTY: '',
      EMPTY_TOKEN: '',
      UNSET_SECRET: undefined,
      HOME: '/home/user',
      COPY_TOKEN: 'openai-canary-4b1e',
    };
    attachSandboxCredentialValues(environment, ['bridged-canary-9a3c', 'openai-canary-4b1e']);

    expect(credentialValuesFromEnvironment(environment, ['TOOL_LOGIN', 'DECLARED_EMPTY'])).toEqual([
      'openai-canary-4b1e',
      'declared-canary-77d0',
      'bridged-canary-9a3c',
    ]);
  });

  it('reads no value of a name outside the credential names when no channel declares it', () => {
    expect(
      credentialValuesFromEnvironment({
        TOOL_LOGIN: 'declared-canary-77d0',
        GH_TOKEN: 'gh-canary',
      }),
    ).toEqual(['gh-canary']);
  });
});

describe('attachSandboxCredentialValues', () => {
  it('attaches a frozen copy that a spread of the environment does not carry', () => {
    const values = ['bridged-canary-9a3c'];
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    attachSandboxCredentialValues(environment, values);
    values.push('late-canary');

    expect(sandboxCredentialValues(environment)).toEqual(['bridged-canary-9a3c']);
    expect(Object.isFrozen(Reflect.get(environment, SANDBOX_CREDENTIAL_VALUES))).toBe(true);
    expect(Object.keys(environment)).toEqual(['PATH']);
    expect(sandboxCredentialValues({ ...environment })).toEqual([]);
  });

  it('attaches an empty list when there is no value', () => {
    const environment: NodeJS.ProcessEnv = {};
    attachSandboxCredentialValues(environment, []);

    expect(Reflect.get(environment, SANDBOX_CREDENTIAL_VALUES)).toEqual([]);
    expect(sandboxCredentialValues(environment)).toEqual([]);
  });
});
