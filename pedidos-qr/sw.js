"use strict";
const CACHE_NAME="el-toque-qr-static-v4";
const SCOPE=self.registration.scope;
const PRECACHE=[
  SCOPE,
  SCOPE+"index.html",
  SCOPE+"catalog.css?v=3",
  SCOPE+"catalog.js?v=3",
  new URL("../config.js",SCOPE).href,
  new URL("../icons/logo-transparent.svg",SCOPE).href,
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async url=>{
      try{const response=await fetch(url,{cache:"reload",mode:url.startsWith("https://cdn.jsdelivr.net")?"no-cors":"same-origin"});if(response.ok||response.type==="opaque")await cache.put(url,response)}catch(_){}
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith("el-toque-qr-")&&k!==CACHE_NAME).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch",event=>{
  const request=event.request;if(request.method!=="GET")return;
  const url=new URL(request.url);
  const isQrAsset=url.origin===location.origin&&(url.pathname.startsWith(new URL(SCOPE).pathname)||url.pathname.endsWith("/config.js")||url.pathname.endsWith("/icons/logo-transparent.svg"));
  const isSupabaseSdk=url.origin==="https://cdn.jsdelivr.net"&&url.pathname.includes("/npm/@supabase/supabase-js@");
  if(!isQrAsset&&!isSupabaseSdk)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(request,{ignoreSearch:false})||await cache.match(url.href);
    if(cached)return cached;
    try{const response=await fetch(request);if(response.ok||response.type==="opaque")cache.put(request,response.clone());return response}
    catch(error){if(request.mode==="navigate"){const fallback=await cache.match(SCOPE+"index.html");if(fallback)return fallback}throw error}
  })());
});
