import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.js',
  // Optional native ws accelerators GramJS's websocket dep probes for.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
console.log('bundled dist/index.js');
