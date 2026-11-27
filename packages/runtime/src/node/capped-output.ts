/**
 * One output stream of a command, held up to a byte limit. Beyond it the answer is cut and SAID to
 * be cut — a truncated transcript that looks complete is worse than no answer at all. The command
 * itself is not interrupted: it still runs to its own end, and its exit status stays real.
 */
export class CappedOutput {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  push(bytes: Uint8Array): void {
    if (this.overflowed) return;
    if (this.total + bytes.byteLength > this.limit) {
      this.chunks.push(bytes.subarray(0, Math.max(0, this.limit - this.total)));
      this.overflowed = true;
      return;
    }
    this.chunks.push(bytes);
    this.total += bytes.byteLength;
  }

  /**
   * What was captured, as text within the limit, and whether anything was cut: bytes past the limit,
   * or a decoded text that outgrew it. Reading changes nothing, so it may be read at any time.
   */
  read(): { text: string; truncated: boolean } {
    const decoded = new TextDecoder().decode(Buffer.concat(this.chunks));
    const encoded = Buffer.from(decoded, 'utf8');
    if (encoded.length <= this.limit) return { text: decoded, truncated: this.overflowed };
    // Invalid source bytes can each expand to U+FFFD. Encode once, then move at most three
    // continuation bytes to retain a valid UTF-8 prefix; never rescan a shrinking multi-MiB string.
    let end = this.limit;
    while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
    return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
  }
}
