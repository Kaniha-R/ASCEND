/* ASCEND service worker — lets reminder notifications work on mobile browsers */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.length) { list[0].postMessage({ type: 'ascend-open-chat' }); return list[0].focus(); }
    return self.clients.openWindow('./index.html#chat');
  }));
});
