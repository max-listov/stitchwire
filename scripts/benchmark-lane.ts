import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { laneParser } from '../packages/runtime/src/transport/lane-parser.ts';
import { observationPayload } from '../test/fixtures/lane-payload.ts';

const encoder = new laneParser.Encoder();
const decoder = new laneParser.Decoder();
decoder.on('decoded', () => {});
const rounds = 300;
function measure(run: () => number) {
  for (let i = 0; i < 30; i++) run();
  const cpu = process.cpuUsage();
  const start = performance.now();
  let bytes = 0;
  for (let i = 0; i < rounds; i++) bytes = run();
  const used = process.cpuUsage(cpu);
  return {
    bytes,
    cpuUsPerPacket: (used.user + used.system) / rounds,
    wallMsPerPacket: (performance.now() - start) / rounds,
  };
}

for (const contentBytes of [1200, 2400, 80000, 326216]) {
  const payload = observationPayload(contentBytes);
  const packet = {
    type: 2,
    nsp: '/',
    data:
      contentBytes < 10000
        ? [
            'event:event',
            {
              topic: 'example.events',
              producer: 'worker',
              subscriptionId: '00000000-0000-4000-8000-000000000001',
              bootId: '00000000-0000-4000-8000-000000000002',
              seq: 1,
              observedAt: null,
              cursor: null,
              encoding: 'base64',
              data: Buffer.from(payload).toString('base64'),
              bytes: contentBytes,
            },
          ]
        : [
            'service:result',
            {
              id: '00000000-0000-4000-8000-000000000001',
              from: 'worker',
              outcome: { payload, status: 'response', delivery: 'received', httpStatus: 200 },
            },
          ],
  };
  const json = measure(() => {
    const bytes = Buffer.from(JSON.stringify(packet));
    JSON.parse(bytes.toString());
    return bytes.length;
  });
  const deflateJson = measure(() => {
    const bytes = deflateRawSync(Buffer.from(JSON.stringify(packet)), { level: 1 });
    JSON.parse(inflateRawSync(bytes).toString());
    return bytes.length;
  });
  const zstdJson = measure(() => {
    const bytes = Bun.zstdCompressSync(Buffer.from(JSON.stringify(packet)), { level: 1 });
    JSON.parse(Buffer.from(Bun.zstdDecompressSync(bytes)).toString());
    return bytes.length;
  });
  const binary = measure(() => {
    const frames = encoder.encode(packet);
    let bytes = 0;
    for (const frame of frames) {
      decoder.add(frame);
      bytes += typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length;
    }
    return bytes;
  });
  console.log(
    JSON.stringify({
      contentBytes,
      rounds,
      json,
      deflateJson,
      zstdJson,
      binary,
      contentReduction: contentBytes / binary.bytes,
      envelopeReduction: json.bytes / binary.bytes,
    }),
  );
}
