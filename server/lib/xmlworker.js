// Parses a big LaunchBox XML file off the main thread (see readLaunchBoxXml). The worker reads
// the file itself, so its text is never copied between threads; only the result is.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { parseLaunchBoxXml } from './xml.js';

parentPort.postMessage(parseLaunchBoxXml(await fs.readFile(workerData, 'utf8'), path.basename(workerData)));
