import { parentPort, workerData } from "node:worker_threads";

const delayMs = Number((workerData as { delayMs: number }).delayMs);
const signal = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(signal, 0, 0, delayMs);
parentPort?.postMessage({ completed: true });
