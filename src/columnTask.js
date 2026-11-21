import { CHUNK_SIZE, CZ_MAX, CZ_MIN, SEA_LEVEL, SEED } from './constants';
import { createGenerator, P } from './generator';
import { buildMesh, buildWaterMesh, coarseFromBricks, packBricks } from './mesher';
import { faceConnectivity, uniformConnectivity } from './visibility';

let generator = null;
const padded = new Uint8Array(P * P * P);

/**
 * Generate the chunks of a column (and mesh them when asked).
 * Runs in the workers, or on the main thread when workers are not available.
 * @returns the result and the buffers to transfer
 */
export function runColumnTask({ id, cx, cy, mesh }) {
    if (!generator) generator = createGenerator(SEED);

    const heights = generator.columnHeights(cx, cy);
    const transfer = [heights.buffer];
    const chunks = [];
    for (let cz = CZ_MIN; cz <= CZ_MAX; cz++) {
        // uniform: 0 all air, 1 all solid, -1 mixed (then the voxels are in bricks)
        const uniform = generator.fillChunk(cx, cy, cz, heights, padded);
        let bricks = null, coarse = null, connectivity;
        if (uniform < 0) {
            bricks = packBricks(padded);
            coarse = coarseFromBricks(bricks);
            connectivity = faceConnectivity(padded);
            transfer.push(bricks.buffer, coarse.buffer);
        } else {
            connectivity = uniformConnectivity(uniform);
        }
        let chunkMesh = null, waterMesh = null;
        const origin = [cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE];
        if (mesh && uniform !== 0) {
            chunkMesh = buildMesh(padded, heights, origin);
            transfer.push(chunkMesh.vertices.buffer);
        }
        if (mesh && uniform !== 1 && origin[2] < SEA_LEVEL) {
            waterMesh = buildWaterMesh(padded, heights, origin);
            if (waterMesh) transfer.push(waterMesh.vertices.buffer);
        }
        chunks.push({ cz, uniform, bricks, coarse, connectivity, mesh: chunkMesh, waterMesh });
    }
    return { result: { id, cx, cy, mesh, heights, chunks }, transfer };
}
