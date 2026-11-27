import { join } from 'node:path';
import { enrollmentEntry, type enrollmentStand } from '../../test/enrollment-stand.ts';
import { admissionRequestExample, admissionResultExample } from '../../test/fleet-admission-examples.ts';
import { run } from './run.ts';

type Stand = Awaited<ReturnType<typeof enrollmentStand>>;

/** Requests built by the packed contract are accepted by the CLI of this tree; its results parse back. */
export async function proveEnrollment(stand: Stand, runtime: string, scratch: string): Promise<void> {
  const input = join(scratch, 'enrollment-stand.json');
  const { tokenSha256: _digest, ...admission } = stand.admission;
  await Bun.write(
    input,
    JSON.stringify({
      admission,
      // A broker that does not answer: the CLI accepts the request and refuses it by name.
      node: { ...stand.request, brokers: [{ id: 'primary', url: 'http://127.0.0.1:9' }] },
      operator: { request: admissionRequestExample, result: admissionResultExample },
    }),
  );
  console.log((await run([runtime, 'client-enrollment.mjs', 'build', input, scratch], scratch)).trim());
  for (const name of ['admission', 'node', 'other-version', 'extra-field']) {
    const request = join(scratch, `${runtime}-${name}.json`);
    const child = Bun.spawn([process.execPath, enrollmentEntry, 'enroll', 'plan', '--request', request], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== (name === 'admission' ? 0 : 2))
      throw new Error(`enroll plan ${name} exited ${code}: ${stdout}`);
    await Bun.write(join(scratch, `${runtime}-${name}-result.json`), stdout);
  }
  console.log((await run([runtime, 'client-enrollment.mjs', 'parse', input, scratch], scratch)).trim());
}
