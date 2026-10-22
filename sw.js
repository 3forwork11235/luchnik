// Service worker «Лучника»: игра открывается и без сети (для игры на одном устройстве
// и для повторного запуска с иконки). Свои файлы — сначала из сети, чтобы обновления
// приходили сразу; без сети — из кэша. Модуль связи PeerJS (с CDN) — из кэша.
const CACHE='luchnik-v7'; // новое имя — старый кэш удалится при обновлении
const SHELL=['./','./index.html','./room.js','./manifest.webmanifest','./icons/icon-180.png','./icons/icon-192.png','./icons/icon-512.png'];
const PEERJS=['https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js','https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js']; // модули связи: P2P и запасной канал

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(
    SHELL.concat(PEERJS).map(u=>c.add(u).catch(()=>{})) // один недоступный файл не должен ломать установку
  )).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});

function fromNetwork(req){
  // сеть с таймаутом: на плохом мобильном интернете не ждём вечно
  return new Promise((res,rej)=>{
    const t=setTimeout(()=>rej(new Error('timeout')),6000);
    // no-cache: браузер сверяет файл с сайтом (GitHub Pages иначе до 10 минут отдаёт старую копию)
    fetch(req,{cache:'no-cache'}).then(r=>{clearTimeout(t);res(r)},err=>{clearTimeout(t);rej(err)});
  });
}

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    if(url.pathname.endsWith('/archer-server.json'))return; // проверка server.py — всегда в сеть
    e.respondWith(fromNetwork(req).then(r=>{
      if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(req,copy))}
      return r;
    }).catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>
      r||(req.mode==='navigate'?caches.match('./index.html').then(i=>i||caches.match('./')):Response.error()))));
    return;
  }
  if(/\/(peerjs|mqtt)@[\d.]+\//.test(url.pathname)){
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(resp=>{
      if(resp.ok||resp.type==='opaque'){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(req,copy))}
      return resp;
    })));
  }
});
