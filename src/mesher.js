import { BRICK_BYTES, BRICKS, CHUNK_SIZE, COARSE, COARSE_BYTES, COARSE_POW, SEA_LEVEL } from './constants';
import { P } from './generator';

// Materials, decoded in fragment.glsl: grass is earth under grass, snow rock under snow; the full ones have the same
// texture on all their faces
export const EARTH = 0, ROCK = 1, GRASS = 2, SNOW = 3, SAND = 4, GRASS_FULL = 5, SNOW_FULL = 6;

const SIZE = CHUNK_SIZE;
const PP = P * P;
const STRIDES = [PP, P, 1];
const SNOW_LINE = 90;

// Face order: +x, -x, +y, -y, +z, -z. Corners are counter-clockwise seen from outside.
export const FACES = [
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
const skyScratch = new Uint8Array(4);
const waterBucket = { data: new Uint32Array(1 << 14), len: 0 };
const waterFlags = new Uint8Array(P * P * P);
const waterQueue = new Int32Array(P * P * P);

function push(bucket, v) {
    if (bucket.len === bucket.data.length) {
        const bigger = new Uint32Array(bucket.data.length * 2);
        bigger.set(bucket.data);
        bucket.data = bigger;
    }
    bucket.data[bucket.len++] = v;
}

function hash(x, y, k) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** patches (0 .. 1) of about cell voxels, with ragged edges: smooth value noise and a little per voxel noise */
function patches(wx, wy, cell, k) {
    const gx = Math.floor(wx / cell), gy = Math.floor(wy / cell);
    let fx = wx / cell - gx, fy = wy / cell - gy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hash(gx, gy, k), b = hash(gx + 1, gy, k), c = hash(gx, gy + 1, k), d = hash(gx + 1, gy + 1, k);
    const smooth = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    return smooth * 0.8 + hash(wx, wy, k + 1) * 0.2;
}

/**
 * Material of a visible voxel, from its depth below the original surface:
 * grass on top (snow above the snow line), a few voxels of earth below, rock deeper and on steep slopes. On top, patches
 * of blocks with grass or snow on all their faces, and of bare earth.
 * Depending on the original surface, a voxel keeps its material when the terrain around it is destroyed.
 */
function material(heights, x, y, wx, wy, wz) {
    const hi = (x + 1) * P + (y + 1);
    const depth = heights[hi] - 1 - wz;
    // lake beds and beaches
    if (heights[hi] <= SEA_LEVEL + 1 && depth >= 0 && depth <= 3) return SAND;
    const slope = Math.max(Math.abs(heights[hi + P] - heights[hi - P]), Math.abs(heights[hi + 1] - heights[hi - 1]));
    const steep = slope >= 3;
    if (depth === 0) {
        const snowLine = SNOW_LINE + ((((wx * 73856093) ^ (wy * 19349663)) >>> 0) % 7) - 3; // ragged snow line
        if (wz >= snowLine) return patches(wx, wy, 7, 11) > 0.5 ? SNOW_FULL : SNOW;
        if (steep) return ROCK;
        const p = patches(wx, wy, 9, 21);
        return p < 0.24 ? EARTH : p > 0.55 ? GRASS_FULL : GRASS;
    }
    if (depth > 0 && depth <= 3 && !steep) return EARTH;
    return ROCK;
}

/**
 * Build the mesh of a padded chunk. A vertex is a single uint32:
 * x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (3 bits)
 * | sky light (3 bits)
 * Each face is 4 vertices; the triangles come from an index buffer shared by all chunks.
 * Faces are grouped by direction so that the directions facing away from the camera can be skipped.
 * @param padded voxels of the chunk and of one voxel around, index ((x + 1) * P + (y + 1)) * P + (z + 1)
 * @param heights surface heights of the columns, index (x + 1) * P + (y + 1)
 * @param origin world position of the chunk
 * @param light sky light (0 .. 15) of the padded voxels, or null (open sky everywhere: quick remesh after an explosion,
 * until the workers send the lit mesh)
 */
export function buildMesh(padded, heights, origin, light = null) {
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

                    // ambient occlusion level per corner: 0 (dark) .. 3 (no occlusion);
                    // smooth sky light per corner: mean light of the air voxels around it, 3 bits
                    const ao = aoScratch, sky = skyScratch;
                    for (let k = 0; k < 4; k++) {
                        const i = f * 4 + k;
                        const j1 = pi + AO_SIDE1[i], j2 = pi + AO_SIDE2[i], jc = pi + AO_CORNER[i];
                        const s1 = padded[j1] !== 0 ? 1 : 0;
                        const s2 = padded[j2] !== 0 ? 1 : 0;
                        const co = padded[jc] !== 0 ? 1 : 0;
                        ao[k] = (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                        if (light === null) {
                            sky[k] = 7;
                        } else {
                            const jn = pi + FACE_NEIGHBOR[f];
                            let sum = light[jn], n = 1;
                            if (!s1) { sum += light[j1]; n++; }
                            if (!s2) { sum += light[j2]; n++; }
                            if (!co && !(s1 && s2)) { sum += light[jc]; n++; }
                            sky[k] = Math.round(sum * 7 / (15 * n));
                        }
                    }

                    // the shared index buffer splits each quad along its 0-2 diagonal;
                    // rotating the corners splits it along 1-3 instead, which avoids
                    // anisotropic ambient occlusion artifacts
                    const start = (ao[0] + ao[2] < ao[1] + ao[3]) ? 1 : 0;
                    const bucket = buckets[f];
                    for (let j = 0; j < 4; j++) {
                        const k = (start + j) & 3;
                        push(bucket, (base + CORNER_BITS[f * 4 + k]) | (f << 21) | (ao[k] << 24) | (sky[k] << 29));
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
 * Mesh of the water of a padded chunk: the faces of the water voxels that touch air. The water of a lake fills all the
 * air below SEA_LEVEL connected to its surface: flood fill from the surface of the lake columns (generated ground below
 * SEA_LEVEL), so that a crater dug in the bed or the shore fills up, and a closed cave stays dry. The fill reaches one
 * voxel into the neighbour chunks (the padding), so a crater across a chunk border fills on both sides.
 * Same vertex format as buildMesh, all 4 corners per face.
 * @returns null when the chunk has no water face; min and max: bounds of the faces in the chunk (for the reflection)
 */
export function buildWaterMesh(padded, heights, origin) {
    const [ox, oy, oz] = origin;
    const surface = SEA_LEVEL - 1 - oz + 1; // padded z index of the highest water voxel
    if (surface < 0 || surface > SIZE + 1) return null; // the chunk does not hold the water surface
    const water = waterFlags;
    water.fill(0);
    let tail = 0;
    for (let i = 0; i < P * P; i++) {
        const idx = i * P + surface;
        if (heights[i] < SEA_LEVEL && padded[idx] === 0) {
            water[idx] = 1;
            waterQueue[tail++] = idx;
        }
    }
    if (tail === 0) return null;
    for (let head = 0; head < tail; head++) {
        const idx = waterQueue[head];
        const x = (idx / PP) | 0, y = ((idx / P) | 0) % P, z = idx % P;
        if (x > 0) tail = flow(idx - PP, tail);
        if (x < P - 1) tail = flow(idx + PP, tail);
        if (y > 0) tail = flow(idx - P, tail);
        if (y < P - 1) tail = flow(idx + P, tail);
        if (z > 0) tail = flow(idx - 1, tail);
        if (z < surface) tail = flow(idx + 1, tail);
    }
    function flow(j, tail) {
        if (water[j] === 0 && padded[j] === 0) {
            water[j] = 1;
            waterQueue[tail++] = j;
        }
        return tail;
    }

    waterBucket.len = 0;
    const min = [SIZE, SIZE, SIZE], max = [0, 0, 0];
    const zEnd = Math.min(surface, SIZE); // local z range of the water in the chunk: 0 .. zEnd - 1
    for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
            for (let z = 0; z < zEnd; z++) {
                const pi = ((x + 1) * P + (y + 1)) * P + (z + 1);
                if (water[pi] === 0) continue;
                const base = x | (y << 7) | (z << 14);
                for (let f = 0; f < 5; f++) { // no face below the water
                    const j = pi + FACE_NEIGHBOR[f];
                    // no face against the ground or between two water voxels
                    if (padded[j] !== 0 || water[j] !== 0) continue;
                    for (let k = 0; k < 4; k++) push(waterBucket, (base + CORNER_BITS[f * 4 + k]) | (f << 21) | (3 << 24));
                    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
                    max[0] = Math.max(max[0], x + 1); max[1] = Math.max(max[1], y + 1); max[2] = Math.max(max[2], z + 1);
                }
            }
        }
    }
    if (waterBucket.len === 0) return null;
    return { vertices: waterBucket.data.slice(0, waterBucket.len), nFaces: waterBucket.len >> 2, min, max };
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
