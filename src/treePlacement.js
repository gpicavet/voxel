import alea from 'alea';
import { createNoise2D } from 'simplex-noise';
import { CHUNK_SIZE, SEA_LEVEL, SEED } from './constants';

// Trees of a column: one candidate per cell of CELL voxels (a grid aligned on the world, so the columns agree), at a
// random place in the cell, kept with the density of the forest there, on grass only. Deterministic: the same trees
// every time the column is generated.

const CELL = 7;
export const TREE_FLOATS = 9; // x, y, z (base), yaw, scale, tint, sky light, sway phase, model

// species: 0 oak, 1 pine, 2 birch, 3 bush, 4 dead tree, 5 blossom; each with a few variants (models of treeModels.js)
export const SPECIES_VARIANTS = [3, 2, 2, 2, 2, 2];
export const MODEL_SPECIES = SPECIES_VARIANTS.flatMap((n, species) => new Array(n).fill(species));
export const MODEL_COUNT = MODEL_SPECIES.length;
const MODEL_FIRST = SPECIES_VARIANTS.map((n, species) => SPECIES_VARIANTS.slice(0, species).reduce((a, b) => a + b, 0));
const SNOW_LINE = 87;

let forestNoise = null;

function hash(x, y, k) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/**
 * species from the altitude and a random number (oak 0, pine 1, birch 2, bush 3, dead 4, blossom 5); grove: inside a
 * grove of blossom trees (in the valleys)
 */
function species(h, r, grove) {
    if (r < 0.03) return 4;
    if (grove && h < 65 && r < 0.65) return 5;
    if (h < 50) return r < 0.55 ? 0 : r < 0.8 ? 2 : 3;
    if (h < 75) return r < 0.3 ? 0 : r < 0.85 ? 1 : 3;
    return r < 0.88 ? 1 : 4;
}

/**
 * @param region voxels of the column box (with the modified chunks), index (x * ny + y) * nz + z
 * @param light sky light of the box
 * @param heights surface heights of the box columns, index x * ny + y
 * @returns { data: Float32Array of TREE_FLOATS per tree, ids: Int32Array }
 */
export function placeTrees(cx, cy, region, light, heights, x0, y0, z0, nx, ny, nz) {
    if (!forestNoise) forestNoise = createNoise2D(alea(SEED + '/forest'));
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
    const data = [], ids = [];
    const solid = (x, y, z) => region[((x - x0) * ny + (y - y0)) * nz + (z - z0)];
    const height = (x, y) => heights[(x - x0) * ny + (y - y0)];

    for (let gx = Math.floor(ox / CELL); gx <= Math.floor((ox + CHUNK_SIZE - 1) / CELL); gx++) {
        for (let gy = Math.floor(oy / CELL); gy <= Math.floor((oy + CHUNK_SIZE - 1) / CELL); gy++) {
            const x = gx * CELL + hash(gx, gy, 1) * CELL, y = gy * CELL + hash(gx, gy, 2) * CELL;
            const ix = Math.floor(x), iy = Math.floor(y);
            if (ix < ox || iy < oy || ix >= ox + CHUNK_SIZE || iy >= oy + CHUNK_SIZE) continue; // another column

            // forests and clearings, and a few lone trees everywhere
            const f = forestNoise(x / 350, y / 350) * 0.6 + forestNoise(x / 90 + 17.3, y / 90 - 4.1) * 0.4;
            const density = 0.03 + 0.82 * smoothstep(-0.05, 0.5, f);
            if (hash(gx, gy, 3) > density) continue;

            // on grass: above the beaches, below the snow, not on steep slopes (rock)
            const h = height(ix, iy);
            const slope = Math.max(Math.abs(height(ix + 1, iy) - height(ix - 1, iy)), Math.abs(height(ix, iy + 1) - height(ix, iy - 1)));
            if (h <= SEA_LEVEL + 1 || h >= SNOW_LINE || slope >= 3) continue;
            // the ground near the height map (the relief moves it a little; not a cave opening, not a crater, not on an
            // outcrop) and room for the trunk
            let ground = -1;
            for (let z = h + 1; z >= h - 2; z--) {
                if (solid(ix, iy, z - 1) && !solid(ix, iy, z) && !solid(ix, iy, z + 1) && !solid(ix, iy, z + 2)) {
                    ground = z;
                    break;
                }
            }
            if (ground < 0) continue;

            const grove = forestNoise(x / 260 + 31.7, y / 260 - 12.9) > 0.45;
            const kind = species(h, hash(gx, gy, 4), grove);
            const scale = kind === 1 ? 0.9 + hash(gx, gy, 5) * 0.5 : 0.75 + hash(gx, gy, 5) * 0.55;
            data.push(
                x, y, ground - 0.15, // slightly in the ground, for slopes
                hash(gx, gy, 6) * Math.PI * 2,
                scale,
                hash(gx, gy, 7),
                light[((ix - x0) * ny + (iy - y0)) * nz + (ground + 1 - z0)] / 15,
                hash(gx, gy, 8) * Math.PI * 2,
                MODEL_FIRST[kind] + Math.floor(hash(gx, gy, 9) * SPECIES_VARIANTS[kind]));
            ids.push(gx * 8192 + gy);
        }
    }
    return { data: new Float32Array(data), ids: new Int32Array(ids) };
}
