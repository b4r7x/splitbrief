import { error, matches } from '../../utils/error.js';

export const rpcError = {
  transportClosed: () => error('rpc-transport-closed', 'RPC transport closed'),
  isTransportClosed: matches('rpc-transport-closed'),
} as const;
