// A slash typed over a panel hands the keyboard to the composer, but Ink gives every key of one
// stdin read to the handlers of the render before it. Until the next commit the panel that let go
// reads this flag, so a ⏎ or a letter in that same read answers none of its rows.
let handing = false;

export function startSlashHandoff(): void {
  handing = true;
}

export function slashHandoffPending(): boolean {
  return handing;
}

export function settleSlashHandoff(): void {
  handing = false;
}
