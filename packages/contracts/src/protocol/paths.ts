import { z } from 'zod';
import { utf8ByteLength } from './payload.ts';

/** `PATH_MAX` of the narrowest supported platform. */
const MAX_FILE_PATH_BYTES = 4096;
/** `sun_path` holds 104 bytes on the narrowest supported platform, one of them the terminating NUL. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** One spelling of one file: absolute, no control characters, no empty, `.` or `..` segment. */
export const AbsoluteFilePathSchema = z
  .string()
  .min(2)
  .startsWith('/')
  .refine(
    (path) =>
      utf8ByteLength(path) <= MAX_FILE_PATH_BYTES &&
      !/\p{Cc}/u.test(path) &&
      !path.includes('//') &&
      !path.split('/').some((segment) => segment === '.' || segment === '..') &&
      !path.endsWith('/'),
    'an absolute file path without control characters or traversal',
  );

export const UnixSocketPathSchema = AbsoluteFilePathSchema.refine(
  (path) => utf8ByteLength(path) <= MAX_UNIX_SOCKET_PATH_BYTES,
  `a Unix socket path of at most ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`,
);

/** A lowercase hexadecimal SHA-256. */
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;
