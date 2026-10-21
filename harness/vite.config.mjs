// The harness builds on its own, into its own directory, and the office server hands it out at /dummy.
// Nothing of it ends up in client/dist and nothing of the client depends on it — the page borrows the
// hearing rule, because a measurement against a different rule would measure nothing.
//
// A plain object on purpose: no imports, so vite can load this config from wherever the binary happens to
// live (the client's node_modules) without resolving anything relative to this directory.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  root: resolve(here, 'dummy'),
  base: '/dummy/',
  // Anything in dummy/public/ is served beside the page: that is where a real recording goes, so the
  // synthetic colleague can speak with somebody's actual voice instead of a generated one.
  publicDir: resolve(here, 'dummy/public'),
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    // Top-level await, so the page can load its voice before it starts talking.
    target: 'esnext',
  },
};
