import { expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  EnrollmentNodeRequestSchema,
  EnrollmentOperationSchema,
} from '../packages/contracts/src/enrollment/request.ts';
import { loadNodeConfig } from '../packages/runtime/src/config/io.ts';
import { offeredEdition } from '../packages/runtime/src/enrollment/material.ts';
import { fixedFacts, prepareNode } from '../packages/runtime/src/enrollment/node.ts';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { fileDigest } from '../packages/runtime/src/enrollment/artifact.ts';
import {
  installationReserved,
  requestedInstallation,
  reserveInstallation,
} from '../packages/runtime/src/enrollment/installation.ts';
import { RequestJournal } from '../packages/runtime/src/enrollment/journal.ts';
import { tablesFor } from '../packages/runtime/src/fleet/bundle.ts';
import { externalSupervisorControl } from './enrollment-controls/negative.ts';
import { enrollmentEntry, enrollmentStand } from './enrollment-stand.ts';
import { withFixtureConfigLock } from './enrollment-lock.ts';
import { refusalOf } from './enrollment-results.ts';

test('unknown pre-existing systemd config refuses before effects; fresh config birth has a durable reservation', async () => {
  const stand = await enrollmentStand();
  const request = EnrollmentNodeRequestSchema.parse({
    ...stand.request,
    supervisor: {
      kind: 'systemd',
      scope: 'system',
      bun: realpathSync(process.execPath),
      artifact: {
        source: enrollmentEntry,
        destination: join(stand.root, 'installed/bin/stitchwire'),
        sha256: fileDigest(enrollmentEntry),
      },
    },
  });
  const installation = requestedInstallation(request);
  if (installation === null || request.supervisor.kind !== 'systemd')
    throw new Error('fixture is supervised');
  const foreign = requestedInstallation({
    ...request,
    supervisor: {
      ...request.supervisor,
      artifact: { ...request.supervisor.artifact, destination: join(stand.root, 'foreign/bin/stitchwire') },
    },
  });
  if (foreign === null) throw new Error('fixture is supervised');
  try {
    const before = readFileSync(request.config);
    for (const operation of EnrollmentOperationSchema.options) {
      // Whose installation this is belongs to preflight in every operation, mutations included.
      expect(refusalOf(await executeEnrollment(request, operation))).toMatchObject({
        code: 'runtime-conflict',
        phase: 'preflight',
      });
      expect(readFileSync(request.config)).toEqual(before);
      expect(existsSync(`${request.config}.enrollment`)).toBe(false);
    }
    // What cannot change while an operation waits is measured once, however often it observes.
    let measured = 0;
    const counting = async () => void measured++;
    const fixed = fixedFacts(request, counting);
    await Promise.all([fixed.artifactChecked(), fixed.artifactChecked()]);
    await fixed.artifactChecked();
    expect(measured).toBe(1);
    // Negative control: the verdict belongs to one operation; the next one measures again.
    await fixedFacts(request, counting).artifactChecked();
    expect(measured).toBe(2);
    unlinkSync(request.config);
    unlinkSync(join(stand.root, `${request.nodeId}-fleet.json`));
    const { material, opened } = offeredEdition(request, null),
      tables = tablesFor(opened, request.nodeId);
    if (tables === null) throw new Error('fixture has no own tables');
    RequestJournal.open(request).save();
    // Simulate the first durable effect of an interrupted fresh prepare, before any config bytes.
    reserveInstallation(request.config, installation);
    expect(existsSync(request.config)).toBe(false);
    await withFixtureConfigLock(request.config, async () =>
      prepareNode(request, { config: null, material, opened, tables }, installation),
    );
    expect(installationReserved(request.config, installation)).toBe(true);
    const created = readFileSync(request.config),
      token = loadNodeConfig(request.config).brokers[0]?.token;
    await withFixtureConfigLock(request.config, async () =>
      prepareNode(
        request,
        { config: loadNodeConfig(request.config), material, opened, tables },
        installation,
      ),
    );
    expect(readFileSync(request.config)).toEqual(created);
    expect(loadNodeConfig(request.config).brokers[0]?.token).toBe(token);
    expect(() => installationReserved(request.config, foreign)).toThrow();
  } finally {
    await stand.stop();
  }
});

test('a live external agent stays unowned even while its Unix door cannot be reached', async () => {
  expect(await externalSupervisorControl(enrollmentEntry)).toBe(true);
}, 30000);
