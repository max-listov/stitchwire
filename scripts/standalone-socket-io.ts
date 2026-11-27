/** Both transport implementations must arrive through the supported literal peer loaders.
 * Package names alone also occur in errors; inspect implementation markers instead.
 * release-smoke verifies the resulting artifact with auto-install disabled and no checkout.
 */
export function assertSocketIoPresent(source: string): void {
  const missing: string[] = [];
  if (!source.includes('engine.io-client')) missing.push('socket.io-client');
  if (!source.includes('socket.io-adapter') && !source.includes('socket.io-parser')) {
    missing.push('socket.io');
  }
  if (missing.length > 0) {
    throw new Error(`standalone artifact is missing bundled transport code: ${missing.join(', ')}`);
  }
}
