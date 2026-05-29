export function encodeSnapshotPath(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('hex');
}

export function decodeSnapshotPath(encodedName: string): string {
  return Buffer.from(encodedName, 'hex').toString('utf8');
}

export function generateSnapshotId(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/[:.]/g, '-');
}
