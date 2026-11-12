import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Absolute, so linked @io-gui packages (whose own node_modules/three points at the three.js checkout)
// still bundle the three pinned in this repo. Bare 'three' is the WebGPU build; otherwise the WebGL build is pulled in beside it.
const threePackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/three')

export const resolveConfig = {
  alias: [
    { find: /^three\/addons\/(.*)$/, replacement: `${threePackage}/examples/jsm/$1` },
    { find: /^three\/addons$/, replacement: `${threePackage}/examples/jsm/Addons.js` },
    { find: /^three\/webgpu$/, replacement: `${threePackage}/build/three.webgpu.js` },
    { find: /^three\/tsl$/, replacement: `${threePackage}/build/three.tsl.js` },
    { find: /^three$/, replacement: `${threePackage}/build/three.webgpu.js` },
  ],
}

// io-gui's @Register / @Property are TypeScript's experimental (legacy) decorators.
export const oxcConfig = {
  decorator: { legacy: true },
}

export default defineConfig({
  // Relative URLs, so dist/ works from any path it is uploaded to.
  base: './',
  server: {
    host: true,
    port: 3000,
    allowedHosts: ['dev.tabanovic.xyz'],
  },
  build: {
    target: 'esnext',
    minify: 'terser',
    terserOptions: {
      // io-gui names custom elements and registrations after classes (`constructor.name`).
      keep_classnames: true,
      keep_fnames: true,
    },
    // three's WebGPU build alone is over a megabyte.
    chunkSizeWarningLimit: 2048,
  },
  resolve: resolveConfig,
  oxc: oxcConfig,
})
