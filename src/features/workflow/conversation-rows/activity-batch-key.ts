export function activityBatchKey(firstIndex: number, callId: string): string {
  return `activity-batch:${firstIndex}:${callId}`;
}
