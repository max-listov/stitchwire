type ObjectBody = { sha: string; type: string; body: Buffer };

/** Tree entries carry every historical spelling; rev-list's single name per blob cannot. */
export function historicalPaths(objects: readonly ObjectBody[], hashBytes: number): Map<string, Set<string>> {
  const trees = new Map<string, Array<{ mode: string; name: string; sha: string }>>();
  const roots = new Set<string>();
  const children = new Set<string>();
  const paths = new Map<string, Set<string>>();
  for (const object of objects) {
    if (object.type === 'commit') {
      const tree = /^tree ([a-f0-9]+)\n/.exec(object.body.toString())?.[1];
      if (!tree) throw new Error('malformed historical commit tree');
      roots.add(tree);
    } else if (object.type === 'tag') {
      const tag = /^object ([a-f0-9]+)\ntype (\w+)\n/.exec(object.body.toString());
      if (!tag) throw new Error('malformed historical tag');
      if (tag[2] === 'tree' && tag[1]) roots.add(tag[1]);
    } else if (object.type === 'tree') {
      const entries: Array<{ mode: string; name: string; sha: string }> = [];
      let at = 0;
      while (at < object.body.length) {
        const space = object.body.indexOf(32, at);
        const zero = object.body.indexOf(0, space + 1);
        if (space < at || zero < space || zero + 1 + hashBytes > object.body.length)
          throw new Error('truncated historical tree');
        const mode = object.body.subarray(at, space).toString('ascii');
        const name = new TextDecoder('utf-8', { fatal: true }).decode(object.body.subarray(space + 1, zero));
        if (
          !/^(40000|100644|100755|120000|160000)$/.test(mode) ||
          !name ||
          name.includes('/') ||
          name === '.' ||
          name === '..'
        )
          throw new Error('malformed historical tree entry');
        const sha = object.body.subarray(zero + 1, zero + 1 + hashBytes).toString('hex');
        entries.push({ mode, name, sha });
        if (mode === '40000') children.add(sha);
        at = zero + 1 + hashBytes;
      }
      trees.set(object.sha, entries);
    }
  }
  for (const sha of trees.keys()) if (!children.has(sha)) roots.add(sha);
  // A directory unchanged between commits is one tree at one path: its leaves are named once, so
  // the walk costs the trees that differ, not every commit times the whole tree.
  const walked = new Set<string>();
  const visit = (sha: string, prefix: string, ancestors: ReadonlySet<string>): void => {
    const place = `${sha} ${prefix}`;
    if (walked.has(place)) return;
    const tree = trees.get(sha);
    if (!tree || ancestors.has(sha)) throw new Error('missing or cyclic historical tree');
    const next = new Set(ancestors).add(sha);
    for (const entry of tree) {
      const path = prefix + entry.name;
      if (entry.mode === '40000') visit(entry.sha, `${path}/`, next);
      else {
        const names = paths.get(entry.sha) ?? new Set<string>();
        names.add(path);
        paths.set(entry.sha, names);
      }
      // Gitlinks name another repository's commit, whose bytes are outside this object database.
    }
    walked.add(place);
  };
  for (const root of roots) visit(root, '', new Set());
  return paths;
}
