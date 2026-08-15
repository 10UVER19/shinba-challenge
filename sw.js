"use strict";

const CACHE_NAME = "shinba-challenge-v2-integrated-5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./css/story.css",
  "./js/app-config.js",
  "./js/race-data.js",
  "./js/validation.js",
  "./js/rating.js",
  "./js/race-importer.js",
  "./js/race-batch-importer.js",
  "./js/newcomer-list.js",
  "./js/bet-plan.js",
  "./js/memo-sync.js",
  "./js/history-model.js",
  "./js/history-store.js",
  "./js/png-exporter.js",
  "./js/story-renderer.js",
  "./js/app.js",
  "./vendor/html2canvas-1.4.1.min.js",
  "./assets/app-icon.svg",
  "./assets/app-icon-180.png",
  "./assets/app-icon-192.png",
  "./assets/app-icon-512.png",
  "./assets/app-icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
