/** Standalone host bundle output. */
import type { UserConfig } from 'tsdown'

const host: UserConfig = {
  name: '@copylee/dsh-computer-use',
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // DSH host libraries are inlined on purpose: the plugin must not depend on
  // the exact rc the host ships.
  deps: { onlyBundle: false },
}

export default [host]
