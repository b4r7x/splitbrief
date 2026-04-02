export interface ServiceCheck {
  name: string;
  url: string;
  available: boolean;
}

export async function checkService(name: string, url: string, timeoutMs = 3000): Promise<ServiceCheck> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { name, url, available: res.ok };
  } catch {
    return { name, url, available: false };
  }
}

export async function checkClaude(): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    await exec('claude', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
