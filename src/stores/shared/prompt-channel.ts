type PromptState<Res> =
  | { status: 'idle' }
  | ({ status: 'pending'; resolve: (res: Res) => void } & Record<string, unknown>);

export interface PromptChannel<Req, Res> {
  open: (req: Req) => Promise<Res>;
  close: (res?: Res) => void;
}

export function createPromptChannel<Req, Res>(deps: {
  get: () => PromptState<Res>;
  setPending: (req: Req, resolve: (res: Res) => void) => void;
  setIdle: () => void;
  supersededValue: Res;
  cancelledValue: Res;
}): PromptChannel<Req, Res> {
  return {
    open(req: Req): Promise<Res> {
      return new Promise<Res>((resolve) => {
        const current = deps.get();
        if (current.status === 'pending') {
          const previousResolve = current.resolve;
          deps.setPending(req, resolve);
          previousResolve(deps.supersededValue);
          return;
        }
        deps.setPending(req, resolve);
      });
    },
    close(res?: Res): void {
      const current = deps.get();
      deps.setIdle();
      if (current.status === 'pending') {
        current.resolve(res ?? deps.cancelledValue);
      }
    },
  };
}
