import { z } from 'zod';

/** Browser-safe failure codes reported by local Wire clients and readers. */
export const ClientErrorCodeSchema = z.enum([
  'invalid-request',
  'closed',
  'capacity',
  'cancelled',
  'timeout',
  'unavailable',
  'permission',
  'transport',
  'http',
  'unsupported',
  'version',
  'invalid-response',
  'limit',
  'unexpected-eof',
]);
export type ClientErrorCode = z.infer<typeof ClientErrorCodeSchema>;
export type DeliveryCertainty = 'not-sent' | 'unknown';
