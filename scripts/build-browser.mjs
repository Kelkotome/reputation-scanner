import { build } from 'esbuild';

// Bundle only the local record service and pure helpers. No runtime CDN or
// external module loader is required; API keys are never build inputs.
await build({
  entryPoints: ['src/browser-api.js'], outfile: 'public/local-api.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  treeShaking: true, sourcemap: false, legalComments: 'none',
});
