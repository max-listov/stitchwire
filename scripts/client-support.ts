/** The installed README must promise exactly the engine floors carried by its package manifest. */
export function assertClientSupport(readme: string, engines: { node: string; bun: string }): void {
  const node = engines.node.replace(/^>=/, '');
  const bun = engines.bun.replace(/^>=/, '');
  if (!readme.replace(/\s+/g, ' ').includes(`Node ${node}+ and Bun ${bun}+;`))
    throw new Error('packed README support floor differs from package engines');
}
