import { checkService, checkClaude } from './connectivity.js';

export interface TestGuard {
  skip: string | false;
}

export async function guardOllama(): Promise<TestGuard> {
  if (process.env['TEST_OLLAMA'] !== 'true' && process.env['INTEGRATION'] !== 'true') {
    return { skip: 'Set TEST_OLLAMA=true or INTEGRATION=true to run Ollama tests' };
  }
  const svc = await checkService('Ollama', 'http://localhost:11434/api/tags');
  if (!svc.available) return { skip: 'Ollama not available at localhost:11434' };
  return { skip: false };
}

export async function guardClaude(): Promise<TestGuard> {
  if (process.env['TEST_CLAUDE'] !== 'true' && process.env['INTEGRATION'] !== 'true') {
    return { skip: 'Set TEST_CLAUDE=true or INTEGRATION=true to run Claude tests (uses subscription tokens!)' };
  }
  const available = await checkClaude();
  if (!available) return { skip: 'Claude Code CLI not found' };
  return { skip: false };
}

export async function guardIntegration(): Promise<TestGuard> {
  if (process.env['INTEGRATION'] !== 'true') {
    return { skip: 'Set INTEGRATION=true to run integration tests' };
  }
  return { skip: false };
}
