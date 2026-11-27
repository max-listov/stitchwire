import { parseJsonBytes, RegularFileError, readRegularFile } from 'stitchkit/files';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../../../contracts/src/service/contracts.ts';
import {
  type ServiceBinding,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
} from '../../../contracts/src/service/policy-schema.ts';

export type DescriptorLoad =
  | { state: 'loaded'; descriptor: ServiceDescriptor }
  | { state: 'invalid' | 'unavailable'; detail: string };

/** Each invocation validates one bounded, stable regular-file snapshot. */
export class ServiceDescriptorStore {
  async load(binding: ServiceBinding, signal?: AbortSignal): Promise<DescriptorLoad> {
    try {
      const body = await readRegularFile(binding.descriptorPath, {
        limit: SERVICE_MAX_DESCRIPTOR_BYTES,
        signal,
      });
      const parsed = ServiceDescriptorSchema.safeParse(parseJsonBytes(body));
      if (!parsed.success)
        return {
          state: 'invalid',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        };
      if (parsed.data.service !== binding.service)
        return {
          state: 'invalid',
          detail: `descriptor service '${parsed.data.service}' does not match binding '${binding.service}'`,
        };
      return { state: 'loaded', descriptor: parsed.data };
    } catch (error) {
      return {
        state: error instanceof RegularFileError && error.reason !== 'changed' ? 'invalid' : 'unavailable',
        // What the parser said is the cause of the refusal; without it the owner reads only "not JSON".
        detail:
          error instanceof RegularFileError
            ? `descriptor ${error.message}${error.cause === undefined ? '' : `: ${String(error.cause)}`}`
            : String(error),
      };
    }
  }
}
