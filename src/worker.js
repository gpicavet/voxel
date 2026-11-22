// Chunk generation and meshing off the main thread. Bundled separately and inlined in main.js (see webpack.config.js).
import { runColumnTask, runHeightGridTask } from './columnTask';
import { buildTreeModels } from './treeModels';

self.onmessage = (event) => {
    if (event.data.type === 'treeModels') {
        const models = buildTreeModels();
        self.postMessage({ type: 'treeModels', models }, models.flatMap(lods => lods.map(lod => lod.vertices.buffer)));
        return;
    }
    const { result, transfer } = event.data.type === 'heightGrid' ? runHeightGridTask(event.data) : runColumnTask(event.data);
    self.postMessage(result, transfer);
};
