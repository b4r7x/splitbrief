export default async function hook(event, _ctx) {
  if (event.type === 'task_started' && event.title?.includes('forbidden')) {
    return { kind: 'deny', message: 'forbidden by sample-module' };
  }
  return { kind: 'allow' };
}
