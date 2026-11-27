/** Process input and output shared by the CLI commands. */

import { MAX_STDIN_BYTES } from '../../../contracts/src/protocol/bounds.ts';

/** One rendering of "no", shared by every command, so a refusal reads the same everywhere. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Stdin above a command's own ceiling; the command decides how to refuse it. */
export class StdinLimitError extends Error {}

/** All of stdin as bytes, never more than `limit`: a pipe cannot grow the process without bound. */
export async function readStdinBytes(limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new StdinLimitError(`stdin exceeds the ${limit} byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** All of stdin, refused past the wire's stdin ceiling. */
export async function readAllStdin(): Promise<string> {
  try {
    return new TextDecoder().decode(await readStdinBytes(MAX_STDIN_BYTES));
  } catch (error) {
    if (error instanceof StdinLimitError) fail(`stdin exceeds the ${MAX_STDIN_BYTES} byte wire limit`);
    throw error;
  }
}

/**
 * Write to stdout and wait for it.
 *
 * `process.stdout.write` into a pipe is asynchronous, and ending the process with `process.exit()`
 * cuts the tail at exactly the pipe buffer, 65536 bytes, with exit code zero and an empty stderr.
 * The data is lost silently: a consumer receives truncated JSON and cannot tell it from a complete
 * one. A redirect to a file delivers everything, which hides the defect from checks that go through `>`.
 */
export function out(text: string | Uint8Array): Promise<number> {
  return Bun.write(Bun.stdout, text);
}
