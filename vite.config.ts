import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Every build names the code it was built from (version + commit + date, e.g. "0.1.0+3f2a9c1 (2026-10-22)"), so a
// figure in an export can always be traced to the code that computed it.
function buildId(): string {
  const version = process.env.npm_package_version ?? '0.0.0';
  let commit = (process.env.GITHUB_SHA ?? '').slice(0, 7);
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      commit = '';
    }
  }
  return `${version}${commit ? `+${commit}` : ''} (${new Date().toISOString().slice(0, 10)})`;
}

// Relative base so the build works from any static host path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildId()),
  },
});
