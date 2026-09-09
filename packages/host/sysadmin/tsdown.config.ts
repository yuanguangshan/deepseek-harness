import { defineConfig } from 'tsdown'

/**
 * Profile-level host plugin: bundles straight from src to lib/index.js,
 * deliberately outside the repo's composite project graph (its typecheck is
 * `tsc --noEmit` against built upstream declarations — see tsconfig.json).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
})
