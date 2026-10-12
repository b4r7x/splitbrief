import { isTestCredentialEnvironmentName } from './hermetic-env.js';

if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1' && process.env.SPLITBRIEF_E2E_RECORD !== '1') {
  for (const name of Object.keys(process.env)) {
    if (isTestCredentialEnvironmentName(name)) delete process.env[name];
  }
}
