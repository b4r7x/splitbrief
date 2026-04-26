import { cliError } from './errors.js';

export function assertNotWindows(): void {
  if (process.platform === 'win32') {
    throw cliError('diptych attach/detach/ps are not supported on Windows.', 1);
  }
}
