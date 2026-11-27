# Development

Use Bun 1.4.4 or a verified compatible version. Run `bun install --frozen-lockfile --ignore-scripts`,
then `bun run verify`. `bun run verify:clean` repeats it from an isolated candidate copy with its
own dependency installation and compares runtime hashes. The packed gate runs ESM and declarations outside
the checkout on Bun and Node, including Unix-only routing, redirects, cancellation and pressure.

On macOS the suite also compiles the launcher and builds the app icon, so `bun run check` needs
`clang` (Xcode Command Line Tools), `iconutil` and `sips` (part of macOS) and `rsvg-convert`
(`brew install librsvg`). Signing the bundle with `bun scripts/macos-bundle.ts` additionally needs
your own Developer ID Application identity; no test requires one.

Keep schemas in `packages/contracts/src`; client never imports runtime and runtime never imports
client. Every executable TypeScript package has its own no-emit check. Test changes through the
real door/broker/agent path when they affect transport; mocked fetch alone does not prove routing.
Add no private customer/project names, fleet topology or operational evidence to tracked files.

The root runtime version and independent client version identify published artifacts, not working
tree completeness. Do not bump them for local-only review. A release requires exact artifacts,
coordinated runtime acceptance and separate authorization; a green local build does not publish.
Two packages are meant for npm, `@stitchwire/client` and `stitchwire`, and neither is published from
a source manifest. Every manifest in the tree — the root and all four workspaces — stays
`private: true`, so `npm publish` or `bun publish` run in the checkout refuses. The build writes the
publishable copies into `dist/`: `bun run build:client` stages `dist/client-package/`, and
`bun run pack:runtime` stages `dist/runtime-package/package/` from the verified standalone build and
macOS native sidecars. The release publisher checks both tarballs against the candidate manifest,
uploads them to npm and verifies them with an anonymous download before publishing the GitHub Release.

Use typed Stitchkit primitives where their semantics match. Do not replace network credit with a
local queue, domain identity with transport IDs, or unknown delivery with retries. Report exact
upstream gaps with a standalone synthetic reproduction rather than a consumer-specific workaround.
