import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'icon-180.png'],
      manifest: {
        name: 'Axiom',
        short_name: 'Axiom',
        description: 'Local-first knowledge OS for researchers',
        theme_color: '#1d2230',
        background_color: '#f7f6f2',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,woff2,mjs}'],
        globIgnores: ['pdfjs/**'],
        navigateFallbackDenylist: [/^\/pdfjs\//],
        runtimeCaching: [
          {
            // pdf.js CMaps / standard fonts / wasm: fetched on demand, then available offline
            urlPattern: ({ url }) => url.pathname.includes('/pdfjs/'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-assets', expiration: { maxEntries: 500 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, host: true },
});
