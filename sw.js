// Funciona sem internet: guarda os arquivos do app no aparelho. A versão muda a cada publicação,
// e o app novo passa a valer na próxima vez que você abrir.
const VERSION = 'e3ee42f6757b';
const FILES = ["./","api-web.js","app.js","detector.js","icons/apple-180.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","manifest.webmanifest","pdf.min.mjs","pdf.worker.min.mjs","style.css","sync.js"];
const CACHE = 'leitor-' + VERSION;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('leitor-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // só os arquivos do próprio app (downloads blob: e outros sites passam direto)
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin + '/')) return;
  if (req.mode === 'navigate') {
    // a página: tenta a internet (para pegar a versão nova), sem internet usa a guardada
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put('./', c)); return r; }).catch(() => caches.match('./', { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
