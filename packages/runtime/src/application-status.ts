import type { projectApplicationStatus } from 'stitchkit/application';
import type { ApplicationStatus } from '../../contracts/src/door/status.ts';

/**
 * The lifecycle kernel's verdict as `/status` and `/health` write it. Every field is named: both
 * writers are strict, so a field the framework adds to its projection would otherwise fail every
 * answer instead of staying out of it.
 */
export function applicationStatus(status: ReturnType<typeof projectApplicationStatus>): ApplicationStatus {
  const { total, ready, degraded, failed } = status.resources;
  return {
    id: status.id,
    lifecycle: status.lifecycle,
    health: status.health,
    ready: status.ready,
    capturedAt: status.capturedAt,
    resources: { total, ready, degraded, failed },
  };
}
