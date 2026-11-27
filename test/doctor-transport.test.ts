import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DoctorReportSchema } from '../packages/runtime/src/cli/doctor-report.ts';
import { cli, doctorTest } from './doctor-fixture.ts';

doctorTest(
  'broker diagnostic refuses redirects, private error bodies and unsafe endpoint options',
  11,
  async () => {
    const root = await mkdtemp('/tmp/wire-doctor-transport-');
    let destinationRequests = 0;
    let originRequests = 0;
    let redirect = true;
    const destination = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        destinationRequests++;
        return Response.json({});
      },
    });
    const origin = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        originRequests++;
        expect(new URL(request.url).pathname).toBe('/health');
        return redirect
          ? Response.redirect(destination.url.href)
          : new Response('private upstream credential detail', { status: 503 });
      },
    });
    try {
      for (const shouldRedirect of [true, false]) {
        redirect = shouldRedirect;
        for (const renderer of [[], ['--json']]) {
          const result = await cli(['--broker', origin.url.href, ...renderer], '/unused', root);
          expect(result.code).toBe(3);
          expect(result.stdout).not.toContain('private upstream credential detail');
          if (renderer.length)
            expect(DoctorReportSchema.parse(JSON.parse(result.stdout)).scope).toBe('broker');
        }
      }
      expect(originRequests).toBe(4);
      expect(destinationRequests).toBe(0);
      for (const args of [
        ['--broker', 'http://example.invalid'],
        ['--broker', `http://synthetic:passwordmarker@127.0.0.1:${origin.port}`],
        ['--broker', `${origin.url.href}?token=synthetic`],
        ['--broker', `${origin.url.href}#private`],
        ['--broker', origin.url.href, '--config', '/unused'],
        ['--broker'],
        ['--unexpected'],
      ]) {
        const result = await cli([...args, '--json'], '/unused', root);
        expect(result.code).toBe(3);
        // The marker is the password itself: a refusal may name the rule (credentials), never the value.
        expect(result.stdout).not.toContain('passwordmarker');
        expect(result.stdout).not.toContain('synthetic');
        expect(DoctorReportSchema.parse(JSON.parse(result.stdout)).verdict).toBe('unknown');
      }
      expect(originRequests).toBe(4);
      expect(destinationRequests).toBe(0);
    } finally {
      origin.stop(true);
      destination.stop(true);
      await rm(root, { recursive: true });
    }
  },
);
