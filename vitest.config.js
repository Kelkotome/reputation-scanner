import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `cloudflare:email` exists only in the Workers runtime; tests use a stand-in.
export default defineConfig({
  resolve: { alias: { 'cloudflare:email': fileURLToPath(new URL('./test/stubs/cloudflare-email.js', import.meta.url)) } },
});
