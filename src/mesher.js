import { BRICK_BYTES, BRICKS, CHUNK_SIZE, COARSE, COARSE_BYTES, COARSE_POW } from './constants';
import { P } from './generator';

// Materials, decoded in vertex.glsl
export const EARTH = 0, ROCK = 1, GRASS = 2, SNOW = 3;

const SIZE = CHUNK_SIZE;
const PP = P * P;
const STRIDES = [PP, P, 1];
const SNOW_LINE = 90;

// Face order: +x, -x, +y, -y, +z, -z. Corners are counter-clockwise seen from outside.
const FACES = [
    { n: [1, 0, 0], c: [[1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]] },
    { n: [-1, 0, 0], c: [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]] },
    { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[1, 1, 1], [0, 1, 1], [0, 0, 1], [1, 0, 1]] },
    { n: [0, 0, -1], c: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
];

// Precomputed per face: offset of the neighbour in the padded array, and for each corner
// the packed corner position and the offsets of the 3 voxels used for ambient occlusion.
const FACE_NEIGHBOR = new Int32Array(6);
const CORNER_BITS = new Uint32Array(24);
const AO_SIDE1 = new Int32Array(24), AO_SIDE2 = new Int32Array(24), AO_CORNER = new Int32Array(24);
FACES.forEach((face, f) => {
    const axis = face.n.findIndex(v => v !== 0);
    const [u, v] = [0, 1, 2].filter(a => a !== axis);
    const nOff = face.n[0] * STRIDES[0] + face.n[1] * STRIDES[1] + face.n[2] * STRIDES[2];
    FACE_NEIGHBOR[f] = nOff;
    face.c.forEach((c, k) => {
        const du = c[u] ? 1 : -1, dv = c[v] ? 1 : -1;
        CORNER_BITS[f * 4 + k] = c[0] | (c[1] << 7) | (c[2] << 14);
        AO_SIDE1[f * 4 + k] = nOff + du * STRIDES[u];
        AO_SIDE2[f * 4 + k] = nOff + dv * STRIDES[v];
        AO_CORNER[f * 4 + k] = nOff + du * STRIDES[u] + dv * STRIDES[v];
    });
});

// One growable list of packed vertices per face direction, reused between chunks.
const buckets = FACES.map(() => ({ data: new Uint32Array(1 << 16), len: 0 }));
const aoScratch = new Uint8Array(4);

function push(bucket, v) {
    if (bucket.len === bucket.data.length) {
        const bigger = new Uint32Array(bucket.data.length * 2);
        bigger.set(bucket.data);
        bucket.data = bigger;
    }
    bucket.data[bucket.len++] = v;
}

/**
 * Material of a visible voxel, from its depth below the original surface:
 * grass on top (snow above the snow line), a few voxels of earth below, rock deeper and on steep slopes.
 * Depending on the original surface, a voxel keeps its material when the terrain around it is destroyed.
 */
function material(heights, x, y, wx, wy, wz) {
    const hi = (x + 1) * P + (y + 1);
    const depth = heights[hi] - 1 - wz;
    const slope = Math.max(Math.abs(heights[hi + P] - heights[hi - P]), Math.abs(heights[hi + 1] - heights[hi - 1]));
    const steep = slope >= 3;
    if (depth === 0) {
        const snowLine = SNOW_LINE + ((((wx * 73856093) ^ (wy * 19349663)) >>> 0) % 7) - 3; // ragged snow line
        if (wz >= snowLine) return SNOW;
        return steep ? ROCK : GRASS;
    }
    if (depth > 0 && depth <= 3 && !steep) return EARTH;
    return ROCK;
}

/**
 * Build the mesh of a padded chunk. A vertex is a single uint32:
 * x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (2 bits)
 * Each face is 4 vertices; the triangles come from an index buffer shared by all chunks.
 * Faces are grouped by direction so that the directions facing away from the camera can be skipped.
 * @param padded voxels of the chunk and of one voxel around, index ((x + 1) * P + (y + 1)) * P + (z + 1)
 * @param heights surface heights of the columns, index (x + 1) * P + (y + 1)
 * @param origin world position of the chunk
 */
export function buildMesh(padded, heights, origin) {
    for (const b of buckets) b.len = 0;
    const [ox, oy, oz] = origin;

    for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
            let pi = (x + 1) * PP + (y + 1) * P;
            for (let z = 0; z < SIZE; z++) {
                pi++;
                if (padded[pi] === 0) continue;

                let base = -1;
                for (let f = 0; f < 6; f++) {
                    if (padded[pi + FACE_NEIGHBOR[f]] !== 0) continue;

                    if (base < 0) {
                        const mat = material(heights, x, y, ox + x, oy + y, oz + z);
                        base = x | (y << 7) | (z << 14) | (mat << 26);
                    }

                    // ambient occlusion level per corner: 0 (dark) .. 3 (no occlusion)
                    const ao = aoScratch;
                    for (let k = 0; k < 4; k++) {
                        const i = f * 4 + k;
                        const s1 = padded[pi + AO_SIDE1[i]] !== 0 ? 1 : 0;
                        const s2 = padded[pi + AO_SIDE2[i]] !== 0 ? 1 : 0;
                        const co = padded[pi + AO_CORNER[i]] !== 0 ? 1 : 0;
                        ao[k] = (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                    }

                    // the shared index buffer splits each quad along its 0-2 diagonal;
                    // rotating the corners splits it along 1-3 instead, which avoids
                    // anisotropic ambient occlusion artifacts
                    const start = (ao[0] + ao[2] < ao[1] + ao[3]) ? 1 : 0;
                    const bucket = buckets[f];
                    for (let j = 0; j < 4; j++) {
                        const k = (start + j) & 3;
                        push(bucket, (base + CORNER_BITS[f * 4 + k]) | (f << 21) | (ao[k] << 24));
                    }
                }
            }
        }
    }

    let total = 0;
    for (const b of buckets) total += b.len;
    const vertices = new Uint32Array(total);
    const faceFirst = new Int32Array(6), faceCount = new Int32Array(6);
    let offs = 0;
    for (let f = 0; f < 6; f++) {
        vertices.set(buckets[f].data.subarray(0, buckets[f].len), offs);
        faceFirst[f] = offs >> 2;
        faceCount[f] = buckets[f].len >> 2;
        offs += buckets[f].len;
    }
    return { vertices, faceFirst, faceCount, nFaces: total >> 2 };
}

/**
 * Pack the inner voxels of a padded chunk into bricks (1 byte per 2x2x2 voxels, bit = (x & 1) | (y & 1) << 1 | (z & 1) << 2,
 * x varying fastest: the layout of the shadow texture) and compute the coarse occupancy (1 byte per 8x8x8 voxels).
 */
export function packBricks(padded) {
    const bricks = new Uint8Array(BRICK_BYTES);
    let i = 0;
    for (let bz = 0; bz < BRICKS; bz++) {
        for (let by = 0; by < BRICKS; by++) {
            for (let bx = 0; bx < BRICKS; bx++) {
                let byte = 0;
                for (let bit = 0; bit < 8; bit++) {
                    const x = (bx << 1) | (bit & 1), y = (by << 1) | ((bit >> 1) & 1), z = (bz << 1) | (bit >> 2);
                    if (padded[((x + 1) * P + (y + 1)) * P + (z + 1)] !== 0) byte |= 1 << bit;
                }
                bricks[i++] = byte;
            }
        }
    }
    return bricks;
}

export function coarseFromBricks(bricks) {
    const coarse = new Uint8Array(COARSE_BYTES);
    const ratio = COARSE_POW - 1; // bricks per coarse cell: 2^(3-1) = 4 per axis
    let i = 0;
    for (let bz = 0; bz < BRICKS; bz++) {
        for (let by = 0; by < BRICKS; by++) {
            for (let bx = 0; bx < BRICKS; bx++) {
                if (bricks[i++] !== 0) {
                    coarse[((bz >> ratio) * COARSE + (by >> ratio)) * COARSE + (bx >> ratio)] = 1;
                }
            }
        }
    }
    return coarse;
}
