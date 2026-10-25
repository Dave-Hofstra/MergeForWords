// Merge for Words — Minimal Service Worker
// Required for PWA install prompt (beforeinstallprompt event)
// No caching: game assets are served fresh (version.json polling drives updates)
// Version: 2026-08-07-v1

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', () => {
  self.clients.claim();
});
