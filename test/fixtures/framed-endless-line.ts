/**
 * Writes a single line without an end. It is the one that can grow without limit — which is what
 * the parser bound exists for, and it must kill such a stream.
 */
const CHUNK = 'x'.repeat(8 * 1024);
for (let i = 0; i < 64; i += 1) process.stdout.write(CHUNK);
await new Promise((resolve) => setTimeout(resolve, 5_000));

export {};
