import { expect, test } from 'bun:test';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessInstanceSchema } from 'stitchkit/process';
import { z } from 'zod';
import { installRuntimeAssets, nativeSidecar, RUNTIME_ENTRY_PATH } from '../scripts/runtime-assets.ts';
import { createRuntimeNativePackaging } from '../scripts/runtime-native-packaging.ts';

const ObservationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('observed'), instance: ProcessInstanceSchema }),
  z.object({ state: z.literal('unavailable'), cause: z.unknown() }),
]);

test('runtime companions preserve framework hashes and refuse missing selected native identity', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wire-native-delivery-'));
  try {
    const native = createRuntimeNativePackaging();
    expect(native.architecture).toEqual(['arm64', 'x64']);
    expect(native.assets.map((asset) => asset.outputPath)).toEqual([
      'native/darwin-arm64.node',
      'native/darwin-x64.node',
    ]);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures/runtime-native-identity.mjs')],
      target: 'bun',
      naming: { entry: RUNTIME_ENTRY_PATH },
      splitting: false,
      plugins: [native.plugin],
    });
    expect(built.success).toBe(true);
    expect(built.outputs.length).toBe(1);
    const [entry] = built.outputs;
    if (!entry) throw new Error('Native delivery probe has no entry');
    const distribution = join(scratch, 'distribution/stitchwire');
    await Bun.write(distribution, await entry.text());
    for (const asset of native.assets) {
      expect(sha256(asset.bytes)).toBe(asset.sha256);
      await Bun.write(nativeSidecar(distribution, asset.architecture), asset.bytes);
    }
    const artifact = join(scratch, 'installed', RUNTIME_ENTRY_PATH);
    installRuntimeAssets(distribution, artifact);
    for (const asset of native.assets) {
      const bytes = await Bun.file(join(scratch, 'installed', asset.outputPath)).bytes();
      expect(sha256(bytes)).toBe(asset.sha256);
    }
    const run = async () => {
      const child = Bun.spawn([process.execPath, artifact], {
        cwd: scratch,
        env: {},
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe('');
        return ObservationSchema.parse(JSON.parse(stdout));
      } finally {
        clearTimeout(timeout);
      }
    };
    const present = await run();
    expect(present.state).toBe('observed');
    if (present.state === 'observed') expect<string>(present.instance.platform).toBe(process.platform);
    if (process.platform === 'darwin') {
      const selected = native.assets.find((asset) => asset.architecture === process.arch);
      if (!selected) throw new Error('Native target is not supported by this delivery probe');
      await rename(join(scratch, 'installed', selected.outputPath), join(scratch, 'held-addon.node'));
      const missing = await run();
      expect(missing.state).toBe('unavailable');
      if (missing.state === 'unavailable')
        expect(missing.cause).toMatchObject({
          code: 'DARWIN_BACKEND_UNAVAILABLE',
          stage: 'resolve',
          nativeCode: 'MODULE_NOT_FOUND',
        });
    } else if (process.platform === 'linux') {
      for (const asset of native.assets) await rm(join(scratch, 'installed', asset.outputPath));
      expect((await run()).state).toBe('observed');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
