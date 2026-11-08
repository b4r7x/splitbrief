import { isTestCredentialEnvironmentName } from './hermetic-env.js';

// These name a tool's config, sign-in and selection folders or a prompt budget, and they win over the HOME a test fakes.
const TESTER_SELECTION_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'SPLITBRIEF_CONTEXT_LENGTH',
];

if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1' && process.env.SPLITBRIEF_E2E_RECORD !== '1') {
  for (const name of Object.keys(process.env)) {
    if (isTestCredentialEnvironmentName(name)) delete process.env[name];
  }
  for (const name of TESTER_SELECTION_ENV) delete process.env[name];
}
