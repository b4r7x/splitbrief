import { spawn } from 'node:child_process';

const KEYCHAIN_PROBE_TIMEOUT_MS = 5_000;

/**
 * Metadata-only presence check for a login-keychain entry. Runs
 * `security find-generic-password -s <service>` without `-w`, discards all
 * output, and reads only the exit code, so no credential value is ever
 * captured or logged. The host HOME is required because macOS resolves the
 * login keychain through `$HOME/Library/Keychains`. Non-darwin hosts report
 * absent.
 */
export function darwinKeychainEntryPresent(
  input: Readonly<{ service: string; signal?: AbortSignal | undefined }>,
): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/security', ['find-generic-password', '-s', input.service], {
      stdio: 'ignore',
      env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' },
      timeout: KEYCHAIN_PROBE_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

export type DarwinKeychainEntryPresent = typeof darwinKeychainEntryPresent;
