// sw.js - RBX Infinity Service Worker
// Scope: notifications only. This does NOT cache the app for offline use —
// that's a separate concern. Registering a service worker is what lets
// notifications shown via registration.showNotification() survive the tab
// being backgrounded/minimized, which plain `new Notification()` doesn't
// reliably do across browsers.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Clicking a notification focuses an existing RBX Infinity tab if one is
// open, or opens a new one at the relevant hash otherwise.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
