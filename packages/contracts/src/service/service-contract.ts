import { defineContract } from 'stitchkit';
import { ServiceCallSchema, LocalServiceResultSchema } from './contracts.ts';
import { SERVICE_MAX_REQUEST_ENVELOPE_BYTES } from './request-bounds.ts';

export const serviceContract = defineContract(
  { prefix: 'wire' },
  {
    invokeService: {
      method: 'POST',
      path: '/services/invoke',
      desc: 'Invoke an explicitly granted owner operation',
      input: ServiceCallSchema,
      output: LocalServiceResultSchema,
      maxJsonBodyBytes: SERVICE_MAX_REQUEST_ENVELOPE_BYTES,
    },
  },
);
