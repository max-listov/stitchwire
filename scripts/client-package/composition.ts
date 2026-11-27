import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * The relative JS chunks a bundle file loads, in every specifier form a bundler emits: a binding
 * import or re-export (`from "./x.js"`), a side-effect-only import (`import "./x.js"`) and a dynamic
 * one (`import("./x.js")`).
 */
function chunkImports(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.\/([^"']+\.js)["']/g)].flatMap(
    ([, chunk]) => (chunk ? [chunk] : []),
  );
}

/** The main entry and the chunks it imports carry nothing of the enrollment contract or fleet bundle. */
export function assertMainComposition(installed: string): void {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const chunk of chunkImports(readFileSync(join(installed, 'dist', name), 'utf8'))) visit(chunk);
  };
  visit('index.js');
  const modules = [...seen].flatMap((name) =>
    [...readFileSync(join(installed, 'dist', name), 'utf8').matchAll(/^\/\/ (packages\/\S+)$/gm)].map(
      ([, module]) => module ?? '',
    ),
  );
  const enrollmentModule = /contracts\/src\/(?:enrollment|fleet\/(?:bundle|manifest))/;
  // Positive control: the same scan finds the contract in the entry that does carry it.
  const own = readFileSync(join(installed, 'dist/enrollment.js'), 'utf8');
  if (
    ![...own.matchAll(/^\/\/ (packages\/\S+)$/gm)].some(([, module]) => enrollmentModule.test(module ?? ''))
  )
    throw new Error('the composition scan does not see the enrollment contract where it is');
  const leaked = modules.filter((module) => enrollmentModule.test(module));
  if (modules.length === 0 || leaked.length > 0)
    throw new Error(
      `main entry composition: ${modules.length} modules, enrollment ${leaked.join(', ') || 'none'}`,
    );
  const bytes = [...seen].reduce((total, name) => total + statSync(join(installed, 'dist', name)).size, 0);
  console.log(
    `main entry: ${[...seen].join(' + ')}, ${new Set(modules).size} modules, ${bytes} bytes, no enrollment`,
  );
}

/**
 * Every JS file the `/contracts` entry loads from `dist`, refused when any carries a token a browser
 * lacks: a Node built-in, `stitchkit`, `Buffer` or `process`.
 */
function scanContractsChunks(dist: string): Set<string> {
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = readFileSync(join(dist, name), 'utf8');
    const code = stripComments(source);
    for (const forbidden of [
      /from\s*["']node:/,
      /\bimport\s*\(?\s*["'](?:node:|stitchkit)/,
      /from\s*["']stitchkit/,
      /\bBuffer\b/,
      /\bprocess\b/,
    ]) {
      if (forbidden.test(code)) {
        throw new Error(`contracts entry ${name} leaked non-browser token ${forbidden}`);
      }
    }
    for (const chunk of chunkImports(source)) visit(chunk);
  };
  visit('contracts.js');
  return seen;
}

/** Negative control: the scan reaches a chunk loaded only by a side-effect import and refuses its leak. */
function controlContractsScan(): void {
  const dist = mkdtempSync(join(tmpdir(), 'wire-contracts-control-'));
  try {
    writeFileSync(join(dist, 'contracts.js'), 'import "./chunk-side.js";\nexport const ok = 1;\n');
    writeFileSync(join(dist, 'chunk-side.js'), 'import { readFileSync } from "node:fs";\nreadFileSync;\n');
    let refused = '';
    try {
      scanContractsChunks(dist);
    } catch (error) {
      refused = String(error);
    }
    if (!refused.includes('chunk-side.js'))
      throw new Error('the contracts scan does not follow a side-effect-only chunk import');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

/** The browser-safe `/contracts` entry, its JS chunks and its entire `.d.ts` graph carry only `zod` + pure contracts. */
export function assertContractsComposition(installed: string): void {
  controlContractsScan();
  const seen = scanContractsChunks(join(installed, 'dist'));

  // Walk the complete transitive `.d.ts` graph from `dist/contracts.d.ts`: only `zod` may appear externally.
  const seenDts = new Set<string>();
  const visitDts = (relPath: string): void => {
    const normalized = resolve(join(installed, 'dist'), relPath);
    if (seenDts.has(normalized)) return;
    seenDts.add(normalized);
    const source = readFileSync(normalized, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(normalized), specifier);
        const targetDts = target.endsWith('.d.ts')
          ? target
          : `${target.replace(/\.(?:js|ts|mjs|mts|cjs|cts)$/, '')}.d.ts`;
        visitDts(targetDts);
      } else if (specifier !== 'zod') {
        throw new Error(`contracts .d.ts graph (${normalized}) leaked external dependency '${specifier}'`);
      }
    }
  };
  visitDts('contracts.d.ts');

  const modules = [...seen].flatMap((name) =>
    [...readFileSync(join(installed, 'dist', name), 'utf8').matchAll(/^\/\/ (packages\/\S+)$/gm)].map(
      ([, module]) => module ?? '',
    ),
  );
  const enrollmentModule = /contracts\/src\/(?:enrollment|fleet\/(?:bundle|manifest))/;
  const leaked = modules.filter((module) => enrollmentModule.test(module));
  if (modules.length === 0 || leaked.length > 0) {
    throw new Error(
      `contracts entry composition: ${modules.length} modules, enrollment ${leaked.join(', ') || 'none'}`,
    );
  }
  const bytes = [...seen].reduce((total, name) => total + statSync(join(installed, 'dist', name)).size, 0);
  console.log(
    `contracts entry: ${[...seen].join(' + ')}, ${new Set(modules).size} modules, ${seenDts.size} d.ts files, ${bytes} bytes, browser-safe`,
  );
}
