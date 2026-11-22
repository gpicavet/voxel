import { CHUNK_SIZE, CZ_MAX, CZ_MIN, SEA_LEVEL, SEED, WORLD_BOTTOM } from './constants';
import { createGenerator, P } from './generator';
import { buildMesh, buildWaterMesh, coarseFromBricks, packBricks } from './mesher';
import { computeSkylight, LIGHT_MARGIN } from './skylight';
import { faceConnectivity, uniformConnectivity } from './visibility';

let generator = null;
const padded = new Uint8Array(P * P * P);
const paddedLight = new Uint8Array(P * P * P);

// box of a column with the light margin: the 4 chunks, their padding voxels, and LIGHT_MARGIN columns around
const M = LIGHT_MARGIN;
const NX = CHUNK_SIZE + 2 * M, NY = NX;
const NZ = (CZ_MAX - CZ_MIN + 1) * CHUNK_SIZE + 2; // from the voxel below the world to the voxel above it
const Z0 = WORLD_BOTTOM - 1;
let region = null, light = null;

/** surface heights of a large area, for the shadow rays that leave the loaded window (see world.js) */
export function runHeightGridTask({ id, x0, y0, n, step }) {
    if (!generator) generator = createGenerator(SEED);
    const heights = generator.heightGrid(x0, y0, n, step);
    return { result: { type: 'heightGrid', id, x0, y0, n, step, heights }, transfer: [heights.buffer] };
}

/** voxels of the modified chunks (main thread) over the generated ones, in the box */
function applyEdits(edits, x0, y0) {
    for (const edit of edits) {
        const ex = edit.cx * CHUNK_SIZE, ey = edit.cy * CHUNK_SIZE, ez = edit.cz * CHUNK_SIZE;
        const xa = Math.max(x0, ex), xb = Math.min(x0 + NX, ex + CHUNK_SIZE);
        const ya = Math.max(y0, ey), yb = Math.min(y0 + NY, ey + CHUNK_SIZE);
        const za = Math.max(Z0, ez), zb = Math.min(Z0 + NZ, ez + CHUNK_SIZE);
        const b = edit.bricks;
        for (let wx = xa; wx < xb; wx++) {
            const x = wx - ex;
            for (let wy = ya; wy < yb; wy++) {
                const y = wy - ey;
                let ri = ((wx - x0) * NY + (wy - y0)) * NZ + (za - Z0);
                for (let wz = za; wz < zb; wz++, ri++) {
                    const z = wz - ez;
                    region[ri] = b ? (b[(((z >> 1) << 5 | (y >> 1)) << 5) | (x >> 1)] >> ((x & 1) | ((y & 1) << 1) | ((z & 1) << 2))) & 1
                        : edit.uniform;
                }
            }
        }
    }
}

function chunkData(cz, uniform, transfer) {
    let bricks = null, coarse = null, connectivity;
    if (uniform < 0) {
        bricks = packBricks(padded);
        coarse = coarseFromBricks(bricks);
        connectivity = faceConnectivity(padded);
        transfer.push(bricks.buffer, coarse.buffer);
    } else {
        connectivity = uniformConnectivity(uniform);
    }
    return { cz, uniform, bricks, coarse, connectivity, mesh: null, waterMesh: null };
}

/**
 * Generate the chunks of a column (and mesh them when asked).
 * Runs in the workers, or on the main thread when workers are not available.
 * @param edits modified chunks of this column and of the 8 around (they change the faces and the light)
 * @param version echoed in the result, to drop meshes made before a later modification
 * @returns the result and the buffers to transfer
 */
export function runColumnTask({ id, cx, cy, mesh, edits = [], version = 0 }) {
    if (!generator) generator = createGenerator(SEED);
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
    const chunks = [];
    const transfer = [];

    if (!mesh) {
        // voxels only (for the shadows): chunk by chunk, no light needed
        const heights = generator.columnHeights(cx, cy);
        transfer.push(heights.buffer);
        for (let cz = CZ_MIN; cz <= CZ_MAX; cz++) {
            // uniform: 0 all air, 1 all solid, -1 mixed (then the voxels are in bricks)
            const uniform = generator.fillChunk(cx, cy, cz, heights, padded);
            chunks.push(chunkData(cz, uniform, transfer));
        }
        return { result: { id, cx, cy, mesh, version, heights, chunks }, transfer };
    }

    // the whole column with its margin at once: voxels, edits, then the sky light
    if (!region) {
        region = new Uint8Array(NX * NY * NZ);
        light = new Uint8Array(NX * NY * NZ);
    }
    const x0 = ox - M, y0 = oy - M;
    const regionHeights = generator.regionHeights(x0, y0, NX, NY);
    generator.fillRegion(x0, y0, Z0, NX, NY, NZ, regionHeights, region);
    applyEdits(edits, x0, y0);
    computeSkylight(region, NX, NY, NZ, light);

    // heights of the column and of the padding columns, for the materials and the water
    const heights = new Int16Array(P * P);
    for (let x = -1; x <= CHUNK_SIZE; x++) {
        for (let y = -1; y <= CHUNK_SIZE; y++) {
            heights[(x + 1) * P + (y + 1)] = regionHeights[(x + M) * NY + (y + M)];
        }
    }
    transfer.push(heights.buffer);

    for (let cz = CZ_MIN; cz <= CZ_MAX; cz++) {
        // padded chunk (and its light) out of the box
        const zStart = cz * CHUNK_SIZE - 1 - Z0;
        let solid = 0;
        for (let x = -1; x <= CHUNK_SIZE; x++) {
            for (let y = -1; y <= CHUNK_SIZE; y++) {
                const src = ((x + M) * NY + (y + M)) * NZ + zStart;
                const dst = ((x + 1) * P + (y + 1)) * P;
                padded.set(region.subarray(src, src + P), dst);
                paddedLight.set(light.subarray(src, src + P), dst);
                if (x >= 0 && y >= 0 && x < CHUNK_SIZE && y < CHUNK_SIZE) {
                    for (let z = 1; z <= CHUNK_SIZE; z++) solid += padded[dst + z];
                }
            }
        }
        const uniform = solid === 0 ? 0 : solid === CHUNK_SIZE ** 3 ? 1 : -1;
        const data = chunkData(cz, uniform, transfer);
        const origin = [ox, oy, cz * CHUNK_SIZE];
        if (uniform !== 0) {
            data.mesh = buildMesh(padded, heights, origin, paddedLight);
            transfer.push(data.mesh.vertices.buffer);
        }
        if (uniform !== 1 && origin[2] < SEA_LEVEL) {
            data.waterMesh = buildWaterMesh(padded, heights, origin);
            if (data.waterMesh) transfer.push(data.waterMesh.vertices.buffer);
        }
        chunks.push(data);
    }
    return { result: { id, cx, cy, mesh, version, heights, chunks }, transfer };
}
