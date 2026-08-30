import { defineConfig } from 'vite'

// Relative base so the same dist/ works anywhere it is unzipped or served from:
// GitHub Pages project path (/ClaudeNautica/), itch.io, or a plain static host.
export default defineConfig({
  base: './',
})
