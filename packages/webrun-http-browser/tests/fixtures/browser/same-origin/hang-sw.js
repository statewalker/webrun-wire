// A worker whose install never finishes, so it never activates.
self.addEventListener("install", (event) => event.waitUntil(new Promise(() => {})));
