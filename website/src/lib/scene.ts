export type Frame = {
  deltaMs: number;
  snap: boolean;
};

export type Scene = {
  advance?(frame: Frame): boolean;
  measure(): void;
  readScroll(): void;
  paint(frame: Frame): boolean;
  destroy(): void;
};
