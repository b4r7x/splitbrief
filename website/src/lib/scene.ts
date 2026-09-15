export type Frame = {
  deltaMs: number;
  elapsedSeconds: number;
  snap: boolean;
};

export type Scene = {
  measure(): void;
  readScroll(): void;
  paint(frame: Frame): boolean;
  destroy(): void;
};
