// Chunk generation and meshing off the main thread. Bundled separately and inlined in main.js (see webpack.config.js).
import { runColumnTask } from './columnTask';

self.onmessage = (event) => {
    const { result, transfer } = runColumnTask(event.data);
    self.postMessage(result, transfer);
};
