import { z } from 'zod';
import { MAX_ARG_BYTES, MAX_STDIN_BYTES } from './bounds.ts';

const utf8Encoder = new TextEncoder();
/** One reused scratch buffer: the count encodes into it slice by slice and keeps nothing. */
const utf8Scratch = new Uint8Array(64 * 1024);
/** A slice of at most a third of the buffer always fits: one UTF-16 unit is at most three bytes. */
const UTF8_SLICE_UNITS = Math.floor(utf8Scratch.length / 3);

/**
 * The UTF-8 byte length of a string, as an encoder writes it (a lone surrogate is U+FFFD, three
 * bytes). Browser-safe, no `Buffer`. It encodes slice by slice into one reused buffer instead of
 * encoding the whole string: the schemas count every command's output, up to megabytes, and a copy
 * per count is garbage of that size (`benchmark:utf8-length` measures both).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + UTF8_SLICE_UNITS);
    // A slice never ends between the two halves of a surrogate pair, which would count each as lone.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    bytes += utf8Encoder.encodeInto(value.slice(start, end), utf8Scratch).written;
    start = end;
  }
  return bytes;
}

function canonicalBase64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** One argument of a command or stream profile: non-empty, within the argument byte bound. */
export const BoundedArgSchema = z.string().min(1).max(MAX_ARG_BYTES);

/** `data` must be canonical base64 of exactly `bytes` bytes: what is declared is what was sent. */
export function base64PayloadRefinement(value: { data: string; bytes: number }, ctx: z.RefinementCtx): void {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    ctx.addIssue({ code: 'custom', path: ['data'], message: 'data must be canonical base64' });
    return;
  }
  if (canonicalBase64ByteLength(value.data) !== value.bytes) {
    ctx.addIssue({ code: 'custom', path: ['bytes'], message: 'bytes must match decoded data length' });
  }
}

/**
 * The byte bounds on what a caller hands a command or a stream profile: the arguments joined by NUL
 * (`name` is the field they live in) and the stdin body. `path` locates the object that holds them.
 */
export function addInputBoundIssues(
  ctx: z.RefinementCtx,
  input: { name: 'argv' | 'args'; values: readonly string[]; stdin: string | null; path?: readonly string[] },
): void {
  const path = input.path ?? [];
  if (utf8ByteLength(input.values.join('\0')) > MAX_ARG_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, input.name],
      message: `${input.name} exceeds ${MAX_ARG_BYTES} bytes`,
    });
  }
  if (input.stdin !== null && utf8ByteLength(input.stdin) > MAX_STDIN_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'stdin'],
      message: `stdin exceeds ${MAX_STDIN_BYTES} bytes`,
    });
  }
}
