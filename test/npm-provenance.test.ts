import { expect, test } from 'bun:test';
import { assertPublisherStatement } from '../scripts/npm-provenance.ts';

test('the registry statement binds the package digest to the tagged workflow commit', () => {
  const source = { slug: 'example/project', tag: 'v1.2.3', sha: '1'.repeat(40) };
  const pkg = { name: '@example/client', version: '2.3.4' },
    sha512 = 'a'.repeat(128);
  const repository = `https://github.com/${source.slug}`,
    ref = `refs/tags/${source.tag}`;
  const invocationId = `${repository}/actions/runs/123/attempts/1`;
  const proof = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/%40example/client@2.3.4', digest: { sha512 } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository, ref, path: '.github/workflows/release.yml' } },
        resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: source.sha } }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId },
      },
    },
  };
  expect(assertPublisherStatement(proof, pkg, sha512, source)).toBe(invocationId);
  for (const edit of [{ sha: '2'.repeat(40) }, { tag: 'v1.2.4' }, { slug: 'example/other' }])
    expect(() => assertPublisherStatement(proof, pkg, sha512, { ...source, ...edit })).toThrow(
      'does not bind',
    );
  expect(() => assertPublisherStatement(proof, pkg, 'b'.repeat(128), source)).toThrow('does not bind');
  expect(() => assertPublisherStatement(proof, { ...pkg, name: 'other' }, sha512, source)).toThrow(
    'does not bind',
  );
});
