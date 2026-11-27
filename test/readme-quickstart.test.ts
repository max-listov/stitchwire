import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWireClient } from '../packages/client/src/index.ts';
import { buildRuntimePackageManifest } from '../scripts/pack-runtime-package.ts';
import { temporaryFile } from './temporary.ts';

/**
 * Every command and import the two READMEs show exists in this tree.
 *
 * A reader copies these blocks before reading anything else, so a script renamed, a file moved or
 * an export dropped must fail here rather than on the first machine that follows the README. A
 * command line this check does not recognise is itself a problem: an unchecked line is the place a
 * stale instruction would hide.
 */
const root = resolve(import.meta.dir, '..');
const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const clientManifest = JSON.parse(readFileSync(resolve(root, 'packages/client/package.json'), 'utf8'));
const runtimeName = buildRuntimePackageManifest(rootManifest).name as string;
const repository = /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(rootManifest.repository.url)?.[1];
const clientEntries = new Map(
  Object.keys(clientManifest.exports).map((subpath) => [
    `${clientManifest.name}${subpath.slice(1)}`,
    resolve(root, 'packages/client/src', `${subpath === '.' ? 'index' : subpath.slice(2)}.ts`),
  ]),
);

type Block = { lang: string; body: string };
function fencedBlocks(markdown: string): Block[] {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(([, lang, body]) => ({
    lang: lang ?? '',
    body: body ?? '',
  }));
}

/** One shell line against the tree; `undefined` means it was checked and holds. */
function commandProblem(line: string): string | undefined {
  const words = line.split(/\s+/);
  const [tool, verb, ...rest] = words;
  if (line === 'bun install --frozen-lockfile --ignore-scripts')
    return existsSync(resolve(root, 'bun.lock')) ? undefined : 'no bun.lock';
  if (tool === 'bun' && verb === 'run')
    return rest[0] !== undefined && rest[0] in rootManifest.scripts ? undefined : `no script ${rest[0]}`;
  if (tool === 'bun' && verb?.startsWith('scripts/'))
    return existsSync(resolve(root, verb)) ? undefined : `no file ${verb}`;
  if ((tool === 'bun' && verb === 'add') || (tool === 'npm' && verb === 'install')) {
    const name = rest.filter((word) => !word.startsWith('-')).join(' ');
    const expected = rest.includes('-g') ? runtimeName : clientManifest.name;
    return name === expected ? undefined : `installs ${name}, the package is ${expected}`;
  }
  if (tool === 'bunx')
    return verb === runtimeName ? undefined : `runs ${verb}, the package is ${runtimeName}`;
  if (tool === 'git' && verb === 'clone')
    return rest[0] === `https://github.com/${repository}.git` ? undefined : `clones ${rest[0]}`;
  if (tool === 'cd') return verb === repository?.split('/')[1] ? undefined : `enters ${verb}`;
  if (tool === 'curl') {
    const url = words.find((word) => word.startsWith('https://'));
    const path = url?.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/);
    if (path?.[1] !== repository) return `fetches ${url} outside ${repository}`;
    return path?.[2] !== undefined && existsSync(resolve(root, path[2])) ? undefined : `no file ${path?.[2]}`;
  }
  return `unchecked command: ${line}`;
}

function shellProblems(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .flatMap((line) => commandProblem(line) ?? []);
}

async function typescriptProblems(body: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [, names, from] of body.matchAll(/^import \{([^}]+)\} from '([^']+)';$/gm)) {
    const entry = clientEntries.get(from ?? '');
    if (entry === undefined) {
      problems.push(`imports ${from}, not a client entry`);
      continue;
    }
    const module = await import(entry);
    for (const name of (names ?? '').split(',').map((part) => part.trim()))
      if (!(name in module)) problems.push(`${from} exports no ${name}`);
  }
  // A path written into the example is a path the reader's agent may not have.
  for (const [literal] of body.matchAll(/'\/[^']*'/g)) problems.push(`hard-coded path ${literal}`);
  using probe = createWireClient({ socketPath: temporaryFile('no-agent-here.sock') });
  for (const [, method] of body.matchAll(/\bwire\.(\w+)\(/g))
    if (typeof (probe as unknown as Record<string, unknown>)[method ?? ''] !== 'function')
      problems.push(`the client has no ${method}()`);
  return problems;
}

async function readmeProblems(markdown: string): Promise<string[]> {
  const problems: string[] = [];
  for (const block of fencedBlocks(markdown)) {
    if (['bash', 'sh'].includes(block.lang)) problems.push(...shellProblems(block.body));
    else if (block.lang === 'ts') problems.push(...(await typescriptProblems(block.body)));
  }
  for (const [, command] of markdown.matchAll(/`((?:bun|bunx|npm) [^`]+)`/g))
    problems.push(...shellProblems(command ?? ''));
  return problems;
}

test('every command and import in both READMEs exists in this tree', async () => {
  for (const path of ['README.md', 'packages/client/README.md']) {
    const markdown = readFileSync(resolve(root, path), 'utf8');
    expect(fencedBlocks(markdown).length).toBeGreaterThan(0);
    expect({ path, problems: await readmeProblems(markdown) }).toEqual({ path, problems: [] });
  }
});

test('a stale script, file, package, export, socket path or method is reported by name', async () => {
  const stale = [
    '```bash',
    'bun run example:missing',
    'bun scripts/missing.ts',
    'bun add @stitchwire/clients',
    'curl -fsSL https://raw.githubusercontent.com/someone/else/main/contrib/install.sh | bash',
    'make install',
    '```',
    '```ts',
    "import { createWireClient, notExported } from '@stitchwire/client';",
    "using wire = createWireClient({ socketPath: '/var/run/agent.sock' });",
    'await wire.invokeEverything();',
    '```',
  ].join('\n');
  expect(await readmeProblems(stale)).toEqual([
    'no script example:missing',
    'no file scripts/missing.ts',
    'installs @stitchwire/clients, the package is @stitchwire/client',
    `fetches https://raw.githubusercontent.com/someone/else/main/contrib/install.sh outside ${repository}`,
    'unchecked command: make install',
    '@stitchwire/client exports no notExported',
    "hard-coded path '/var/run/agent.sock'",
    'the client has no invokeEverything()',
  ]);
});
