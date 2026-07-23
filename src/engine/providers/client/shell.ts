export function createProviderShell(base: { name: string; baseURL: string; isLocal: boolean }): {
  base: { name: string; baseURL: string; isLocal: boolean };
  trackError(message: string | undefined): void;
  getLastError(): string | undefined;
} {
  let lastError: string | undefined;
  return {
    base,
    trackError(message: string | undefined) {
      lastError = message;
    },
    getLastError() {
      return lastError;
    },
  };
}
