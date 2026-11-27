import { z } from 'zod';

/**
 * Whether a URL host is this machine: `localhost`, `::1` or any address of 127.0.0.0/8, after URL
 * normalisation. `localhost` is trusted by its name and not resolved: a lane rule that asked DNS
 * would answer differently on each machine. A trailing-dot `localhost.`, a `*.localhost` name and
 * an IPv4-mapped `::ffff:127.0.0.1` are not loopback here and are refused.
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Why a broker lane URL is refused, or `null`. This is the one rule for a broker address: `node.json`,
 * an enrollment request, `doctor --broker` and `readBrokerHealth` all ask it.
 *
 * - It must be a URL.
 * - It carries no credentials, query string or fragment: the node's token is its credential, and a
 *   lane has no parameters. A path is allowed (`wss://broker.example/edge`).
 * - The lane carries the node's token and every call, stream and event, so it is TLS (`https:`,
 *   `wss:`) except to a broker on this machine, where `http:` and `ws:` are allowed.
 *
 * The reason never repeats the URL, which may hold credentials.
 */
export function laneUrlRefusal(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.username !== '' || url.password !== '')
    return 'a broker lane URL carries no credentials: the node token is sent by the transport';
  if (url.href.includes('?') || url.href.includes('#'))
    return 'a broker lane URL carries no query string or fragment';
  if (url.protocol === 'https:' || url.protocol === 'wss:') return null;
  if (url.protocol === 'http:' || url.protocol === 'ws:')
    return isLoopbackHost(url.hostname)
      ? null
      : `${url.protocol} is plain text: a broker lane outside loopback (127.0.0.0/8, ::1, localhost) requires https: or wss:`;
  return `unsupported scheme ${url.protocol}: a broker lane is https: or wss: (http: or ws: on loopback only)`;
}

/** A broker lane URL in a schema, refused by `laneUrlRefusal` and by nothing else. */
export const LaneUrlSchema = z.string().superRefine((value, ctx) => {
  const refusal = laneUrlRefusal(value);
  if (refusal !== null) ctx.addIssue({ code: 'custom', message: refusal });
});
