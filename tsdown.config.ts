/**
 * Client-bundle build for the dsh-literature Harness UI.
 *
 * Emits the same closure-factory artifact the dsh web shell expects: the
 * bundle calls window.__ModuleLoader__.load({ id, factory }) and resolves
 * externals through the injected require (the shell's frozen module table —
 * react family + platform seed words). Only the react family is imported as
 * values by this client half; everything else stays type-only, so the table
 * list below is exactly the module set the bundle may require at runtime.
 */
import { defineConfig } from 'tsdown'

/** Module-table specifiers the shell shares into the loader (see seed.ts). */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig({
  name: 'dsh-literature/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Inline everything else (helpers, wire types are type-only anyway).
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-literature", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
