import { parentPort, workerData } from 'node:worker_threads';
import { error } from '../../../utils/error.js';
import { parsePayload, type ModelsDevParseRequest } from './record.js';

if (parentPort === null)
  throw error('models-dev-parser-port-missing', 'Models.dev parser requires a worker port.');
const request: ModelsDevParseRequest = workerData;
parentPort.postMessage(parsePayload(request));
