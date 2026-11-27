import {
  ServiceCancellationOriginSchema,
  type ServiceCancellationOrigin,
} from '../../../contracts/src/service/diagnostics.ts';

export function serviceAbortOrigin(signal?: AbortSignal): ServiceCancellationOrigin {
  const parsed = ServiceCancellationOriginSchema.safeParse(signal?.reason);
  return parsed.success ? parsed.data : 'caller-abort';
}
