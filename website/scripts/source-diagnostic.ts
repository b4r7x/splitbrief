export type SourceDiagnostic = {
  readonly file: string;
  readonly line?: number;
  readonly message: string;
};
