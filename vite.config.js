import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Web Bluetooth y los sensores de movimiento exigen HTTPS (localhost es excepción).
// Para probar en el teléfono dentro de la red local:  npm run dev:https
export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'SafeMotion AI',
        short_name: 'SafeMotion',
        description: 'Monitoreo de movimiento y salud con wearable BLE y sensores del teléfono.',
        lang: 'es',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#EEF2F6',
        theme_color: '#1F3FBF',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      // /api/* lo reenvía Vercel al backend Spring (vercel.json): el service worker no debe responderlo con index.html
      workbox: { navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//], globPatterns: ['**/*.{js,css,html,svg,png}'] },
      devOptions: { enabled: true }
    }),
    ...(process.env.HTTPS ? [basicSsl()] : [])
  ]
});
