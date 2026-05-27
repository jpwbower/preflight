import { defineConfig } from 'preflight';

// CI smoke config: runs against the local ci/fixture/index.html
// served by http-server on port 5050. Deterministic — example.com
// from CI would flake on network latency and rate limits, and would
// not prove that the published tarball actually wires up against a
// local webServer (which is the common consumer shape).
export default defineConfig({
  baseURL: 'http://127.0.0.1:5050',
  routes: [{ name: 'home', path: '/' }],
  webServer: {
    command: 'npx http-server fixture -p 5050 -c-1 --silent',
    url: 'http://127.0.0.1:5050',
    timeout: 30_000,
  },
});
