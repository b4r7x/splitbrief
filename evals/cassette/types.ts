export type CassetteEntry = {
  index: number;
  timestamp: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  durationMs: number;
};

export type Cassette = {
  version: 1;
  scenarioId: string;
  mode: 'baseline' | 'routed';
  plannerModel: string;
  implementerModel: string;
  recordedAt: string;
  entries: CassetteEntry[];
};
