const CACHE_NAME = "ipv-digital-shell-v10";
const APP_FILES = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js"
];
self.addEventListener("install", event => {
  event.waitUntil((async()=>{const cache=await caches.open(CACHE_NAME);await cache.addAll(APP_FILES);await Promise.all(CDN_FILES.map(async url=>{try{const response=await fetch(url,{mode:"cors"});if(response.ok)await cache.put(url,response);}catch(_){}}));await self.skipWaiting();})());
});
self.addEventListener("activate", event => event.waitUntil((async()=>{for(const key of await caches.keys())if(key!==CACHE_NAME)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener("fetch", event => {
  const request=event.request;if(request.method!=="GET")return;
  const url=new URL(request.url);if(url.origin!==self.location.origin&&!CDN_FILES.includes(request.url))return;
  event.respondWith((async()=>{const cache=await caches.open(CACHE_NAME);const cached=await cache.match(request,{ignoreSearch:true});const isAppShell=url.origin===self.location.origin&&["/","/index.html","/app.js","/styles.css","/config.js"].some(path=>url.pathname.endsWith(path));if(isAppShell){try{const response=await fetch(request,{cache:"no-store"});if(response.ok)await cache.put(request,response.clone());return response;}catch(_){return cached||Response.error();}}if(cached)return cached;try{const response=await fetch(request);if(response.ok)cache.put(request,response.clone());return response;}catch(_){return cached||Response.error();}})());
});
