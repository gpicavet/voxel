// Chunk generation and meshing off the main thread. Bundled separately and inlined in main.js (see webpack.config.js).
import { runColumnTask, runHeightGridTask } from './columnTask';

self.onmessage = (event) => {
    const { result, transfer } = event.data.type === 'heightGrid' ? runHeightGridTask(event.data) : runColumnTask(event.data);
    self.postMessage(result, transfer);
};
