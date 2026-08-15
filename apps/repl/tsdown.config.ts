import { defineConfig } from 'tsdown'

/**
 * The TUI REPL ships one entry: the `bin` referenced by package.json `bin`.
 * The root tsdown builds only `lib/types/index.js`, so this override points at
 * `lib/types/bin.js` instead; its reachable modules (TUI glue, core, and the
 * session reducer) bundle with it. Declarations come from `tsc -b`
 * (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Bundle the private front-end closure (@deepseek-ai/*) INTO lib/bin.js so
  // the published tarball runs without a registry that carries those packages:
  // a standalone install only needs public deps (pi-tui, js-yaml) via npm.
  // The sdk-client and its @deepseek-ai peers stay in devDependencies so the
  // TypeScript build can resolve their types during `tsc -b`.
  deps: {
    alwaysBundle: [/@deepseek-ai\//],
  },
})
