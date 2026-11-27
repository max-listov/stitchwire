import { z } from 'zod';

/**
 * The path of one route an owner serves: an operation's `path` and a binding's `endpointPath`.
 *
 * One rule for both, because a route path crosses a URL parser on its way to the owner: `.` and
 * `..` segments are resolved there, so `/catalog/x/../erase` reaches the handler of `/catalog/erase`
 * and a read operation would run a write route. A `.` inside a longer segment (`/v1.2/x`) is an
 * ordinary character and stays allowed. The alphabet is the characters a URL path carries
 * unescaped; no percent escapes, so no spelling of a dot segment the check cannot see.
 */
export const OwnerRoutePathSchema = z
  .string()
  .max(512)
  .regex(/^\/[a-zA-Z0-9._/-]+$/)
  .refine(
    (path) =>
      !path.endsWith('/') &&
      !path.includes('//') &&
      !path.split('/').some((segment) => segment === '.' || segment === '..'),
    'route path must have no empty, "." or ".." segment and no trailing "/"',
  );
