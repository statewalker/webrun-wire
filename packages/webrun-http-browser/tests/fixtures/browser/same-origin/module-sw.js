// The library's same-origin dispatcher in an ES-module worker: registered with `type: "module"`,
// it imports the dispatcher instead of `importScripts`-ing `sw-worker.js` (a module worker cannot).
import { startHttpDispatcher } from "/dist/sw.js";

startHttpDispatcher({ log: console.log, self });
