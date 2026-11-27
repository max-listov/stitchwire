import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';

test('publication catalog inherits CLI auth/config environment and runs a Bun shebang tool', async () => {
  const root = mkdtempSync('/tmp/wire-gh-env-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bun\nconst present=['HOME','PATH','GH_TOKEN','GH_CONFIG_DIR','SSH_AUTH_SOCK','WIRE_ENV_SENTINEL'].every(key=>Boolean(process.env[key])); if(!present)process.exit(3); console.log(JSON.stringify([[{tag_name:'v0.1.0',assets:[]}]]));\n`,
    );
    chmodSync(gh, 0o700);
    const entry = join(import.meta.dir, '../scripts/published-sdk.ts');
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [
        '--eval',
        `const {publishedReleases}=await import(${JSON.stringify(entry)}); const catalog=await publishedReleases('example/product'); console.log(JSON.stringify({inherited:Array.isArray(catalog)}));`,
      ],
      envPolicy: 'declared-only',
      env: {
        HOME: root,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GH_TOKEN: 'fixture',
        GH_CONFIG_DIR: root,
        SSH_AUTH_SOCK: join(root, 'fixture.sock'),
        WIRE_ENV_SENTINEL: 'fixture',
      },
      capture: true,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect({ code: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toEqual({
      code: 0,
      stderr: '',
    });
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ inherited: true });
    const negative = await runNativeCommand({
      executable: gh,
      args: [],
      capture: true,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(negative.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
