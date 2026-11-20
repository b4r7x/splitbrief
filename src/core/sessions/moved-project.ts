const LEAD = 'This run started in ';
const ACTION =
  'Move the project back to that folder and start SPLITBRIEF there to continue the run, or end the run.';

export const MOVED_PROJECT_ACTION = 'Move the project back or end the run';

export function movedProjectMessage(dir: string): string {
  return `${LEAD}${dir}. ${ACTION}`;
}

/** Older saved failures carry the message alone. Read the original directory from that receipt. */
export function movedProjectPath(message: string | null | undefined): string | undefined {
  if (!message?.startsWith(LEAD) || !message.endsWith(`. ${ACTION}`)) return undefined;
  return message.slice(LEAD.length, -(ACTION.length + 2));
}
