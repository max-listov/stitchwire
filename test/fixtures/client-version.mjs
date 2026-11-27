import assert from 'node:assert/strict';
import { LOCAL_API_VERSION } from '@stitchwire/client';
import { runtime } from './_door.mjs';

// Expected revision comes from the source contract outside this isolated installed package.
const expected = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(expected) && expected > 0, 'source Door version is required');
assert.equal(LOCAL_API_VERSION, expected, 'installed SDK Door version differs from source contract');
console.log(
  JSON.stringify({
    packedDoorVersion: LOCAL_API_VERSION,
    matchesSourceContract: true,
    runtime,
  }),
);
