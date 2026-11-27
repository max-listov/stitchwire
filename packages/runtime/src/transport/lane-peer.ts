import { io, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { laneParser } from './lane-parser.ts';

/** Wire owns the packet codec; Stitchkit owns connection lifecycle and contract validation. */
export async function loadLanePeer() {
  return {
    io: (url: string, options: Partial<ManagerOptions & SocketOptions>) =>
      io(url, { ...options, parser: laneParser }),
  };
}
