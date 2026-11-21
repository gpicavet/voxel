import alea from 'alea';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { BEDROCK_TOP, CHUNK_SIZE, MAX_HEIGHT, SEA_LEVEL, WORLD_BOTTOM, WORLD_MAX_XY, WORLD_MIN_XY } from './constants';

// Padded chunk: the chunk and one voxel of its neighbours on every side (what the mesher needs).
export const P = CHUNK_SIZE + 2;

// Cave noise is sampled every GRID voxels and interpolated: about 60 times fewer noise evaluations.
const GRID = 4;
const GRID_SPAN = CHUNK_SIZE / GRID + 3; // grid points covering a padded chunk on one axis

const TUNNEL_SCALE = 1 / 64, TUNNEL_SCALE_Z = 1 / 40, TUNNEL_WIDTH = 0.004;
const CAVERN_SCALE = 1 / 90, CAVERN_THRESHOLD = 0.64;

function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

function trilerp(c000, c100, c010, c110, c001, c101, c011, c111, fx, fy, fz) {
    const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
}

/**
 * Minecraft-like terrain: a height map (plains, hills, ridged mountain ranges) with tunnels and caverns underground.
 * Deterministic: the same seed gives the same world in every worker and on the main thread.
 */
export function createGenerator(seed) {
    const heightNoise = createNoise2D(alea(seed + '/height'));
    const mountainNoise = createNoise2D(alea(seed + '/mountains'));
    const tunnelA = createNoise3D(alea(seed + '/tunnelA'));
    const tunnelB = createNoise3D(alea(seed + '/tunnelB'));
    const cavern = createNoise3D(alea(seed + '/cavern'));

    function fbm(noise, x, y, octaves) {
        let sum = 0, amplitude = 1, norm = 0;
        for (let i = 0; i < octaves; i++) {
            sum += amplitude * noise(x, y);
            norm += amplitude;
            amplitude *= 0.5;
            x *= 2;
            y *= 2;
        }
        return sum / norm; // [-1, 1]
    }

    // sharp crests: 1 - |noise|, squared
    function ridged(noise, x, y, octaves) {
        let sum = 0, amplitude = 1, norm = 0;
        for (let i = 0; i < octaves; i++) {
            const r = 1 - Math.abs(noise(x, y));
            sum += amplitude * r * r;
            norm += amplitude;
            amplitude *= 0.5;
            x *= 2;
            y *= 2;
        }
        return sum / norm; // [0, 1]
    }

    /** number of solid voxels above z = 0 in the column (x, y): the top voxel is at z = height - 1 */
    function surfaceHeight(x, y) {
        const base = fbm(heightNoise, x / 900, y / 900, 4);                    // plains and large hills
        const detail = fbm(heightNoise, x / 160 + 31.7, y / 160 - 12.3, 3);     // small hills
        // mountain ranges almost everywhere, with a few plains between them
        const ranges = smoothstep(-0.55, 0.15, fbm(mountainNoise, x / 1800, y / 1800, 3));
        const peaks = smoothstep(0.05, 0.85, ridged(mountainNoise, x / 420 + 7.1, y / 420 + 3.3, 5)); // stretched to reach 1
        // at most 22 + 8 + 4 + 86 = 120 = MAX_HEIGHT: mountains are never cut by the top of the world
        return Math.floor(22 + 8 * base + 4 * detail + 86 * ranges * peaks);
    }

    function gridValue(noise, scale, scaleZ, gx, gy, gz) {
        return noise(gx * GRID * scale, gy * GRID * scale, gz * GRID * scaleZ);
    }

    // interpolated cave noise at one voxel (same corners and same interpolation as fillChunk)
    function sample(noise, scale, scaleZ, x, y, z) {
        const gx = Math.floor(x / GRID), gy = Math.floor(y / GRID), gz = Math.floor(z / GRID);
        const fx = (x - gx * GRID) / GRID, fy = (y - gy * GRID) / GRID, fz = (z - gz * GRID) / GRID;
        const v = (dx, dy, dz) => gridValue(noise, scale, scaleZ, gx + dx, gy + dy, gz + dz);
        return trilerp(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(1, 1, 0), v(0, 0, 1), v(1, 0, 1), v(0, 1, 1), v(1, 1, 1), fx, fy, fz);
    }

    // b and c are only evaluated when they can change the result
    function needsB(a) {
        return a * a < TUNNEL_WIDTH;
    }
    function needsC(z, h) {
        return z < h - 20 && z < -16;
    }
    function isCave(z, h, a, b, c) {
        if (z < BEDROCK_TOP) return false;                  // bedrock layers
        if (h < SEA_LEVEL + 2 && z >= h - 5) return false;  // lake beds stay sealed: no tunnel opens under the water
        if (a * a + b * b < TUNNEL_WIDTH) return true;       // tunnels: where two noise surfaces cross
        return needsC(z, h) && c > CAVERN_THRESHOLD;         // large caverns, deep only
    }

    /** solidity of one voxel, without generating its chunk */
    function solidAt(x, y, z) {
        if (z < WORLD_BOTTOM) return 1;
        if (x < WORLD_MIN_XY || x >= WORLD_MAX_XY || y < WORLD_MIN_XY || y >= WORLD_MAX_XY) return 0;
        const h = surfaceHeight(x, y);
        if (z >= h) return 0;
        const a = sample(tunnelA, TUNNEL_SCALE, TUNNEL_SCALE_Z, x, y, z);
        const b = needsB(a) ? sample(tunnelB, TUNNEL_SCALE, TUNNEL_SCALE_Z, x, y, z) : 1;
        const c = needsC(z, h) ? sample(cavern, CAVERN_SCALE, CAVERN_SCALE, x, y, z) : 0;
        return isCave(z, h, a, b, c) ? 0 : 1;
    }

    /** surface heights of a chunk column and of the columns around it: P x P values, index (x + 1) * P + (y + 1) */
    function columnHeights(cx, cy) {
        const heights = new Int16Array(P * P);
        const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
        for (let x = -1; x <= CHUNK_SIZE; x++) {
            for (let y = -1; y <= CHUNK_SIZE; y++) {
                heights[(x + 1) * P + (y + 1)] = surfaceHeight(ox + x, oy + y);
            }
        }
        return heights;
    }

    // Float64 like the values computed by sample(): solidAt and fillChunk must agree on every voxel
    const grids = [new Float64Array(GRID_SPAN ** 3), new Float64Array(GRID_SPAN ** 3), new Float64Array(GRID_SPAN ** 3)];

    /**
     * Voxels of a padded chunk (index ((x + 1) * P + (y + 1)) * P + (z + 1), 1 = solid) into out.
     * @returns 0 if all air, 1 if all solid, -1 otherwise
     */
    function fillChunk(cx, cy, cz, heights, out) {
        const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE, oz = cz * CHUNK_SIZE;

        let maxHeight = -Infinity;
        for (let i = 0; i < heights.length; i++) maxHeight = Math.max(maxHeight, heights[i]);
        if (oz - 1 >= maxHeight) {
            out.fill(0);
            return 0;
        }

        // cave noise grid: points g0 .. g0 + GRID_SPAN - 1 on each axis
        const g0x = Math.floor((ox - 1) / GRID), g0y = Math.floor((oy - 1) / GRID), g0z = Math.floor((oz - 1) / GRID);
        const params = [[tunnelA, TUNNEL_SCALE, TUNNEL_SCALE_Z], [tunnelB, TUNNEL_SCALE, TUNNEL_SCALE_Z], [cavern, CAVERN_SCALE, CAVERN_SCALE]];
        params.forEach(([noise, scale, scaleZ], n) => {
            const grid = grids[n];
            let i = 0;
            for (let gx = 0; gx < GRID_SPAN; gx++)
                for (let gy = 0; gy < GRID_SPAN; gy++)
                    for (let gz = 0; gz < GRID_SPAN; gz++)
                        grid[i++] = gridValue(noise, scale, scaleZ, g0x + gx, g0y + gy, g0z + gz);
        });
        const S2 = GRID_SPAN * GRID_SPAN;
        const interpolate = (grid, gi, fx, fy, fz) => trilerp(
            grid[gi], grid[gi + S2], grid[gi + GRID_SPAN], grid[gi + S2 + GRID_SPAN],
            grid[gi + 1], grid[gi + S2 + 1], grid[gi + GRID_SPAN + 1], grid[gi + S2 + GRID_SPAN + 1], fx, fy, fz);

        let solid = 0, total = 0;
        for (let x = -1; x <= CHUNK_SIZE; x++) {
            const wx = ox + x;
            const outsideX = wx < WORLD_MIN_XY || wx >= WORLD_MAX_XY;
            const gx = Math.floor(wx / GRID), fx = (wx - gx * GRID) / GRID;
            for (let y = -1; y <= CHUNK_SIZE; y++) {
                const wy = oy + y;
                const outside = outsideX || wy < WORLD_MIN_XY || wy >= WORLD_MAX_XY;
                const h = heights[(x + 1) * P + (y + 1)];
                const gy = Math.floor(wy / GRID), fy = (wy - gy * GRID) / GRID;
                let pi = ((x + 1) * P + (y + 1)) * P;
                for (let z = -1; z <= CHUNK_SIZE; z++, pi++) {
                    const wz = oz + z;
                    let v;
                    if (wz < WORLD_BOTTOM) {
                        v = 1;
                    } else if (outside || wz >= h) {
                        v = 0;
                    } else {
                        const gz = Math.floor(wz / GRID), fz = (wz - gz * GRID) / GRID;
                        const gi = ((gx - g0x) * GRID_SPAN + (gy - g0y)) * GRID_SPAN + (gz - g0z);
                        const a = interpolate(grids[0], gi, fx, fy, fz);
                        const b = needsB(a) ? interpolate(grids[1], gi, fx, fy, fz) : 1;
                        const c = needsC(wz, h) ? interpolate(grids[2], gi, fx, fy, fz) : 0;
                        v = isCave(wz, h, a, b, c) ? 0 : 1;
                    }
                    out[pi] = v;
                    if (x >= 0 && y >= 0 && z >= 0 && x < CHUNK_SIZE && y < CHUNK_SIZE && z < CHUNK_SIZE) {
                        solid += v;
                        total++;
                    }
                }
            }
        }
        return solid === 0 ? 0 : solid === total ? 1 : -1;
    }

    return { surfaceHeight, solidAt, columnHeights, fillChunk };
}
