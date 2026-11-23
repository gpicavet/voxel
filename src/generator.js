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

// Relief in 3D near the surface (the height map alone gives regular stairs), from 3D noises on the same grid:
// - ledges: the surface moved up and down by a noise that varies with the altitude, on the slopes only (more on the
//   steep ones): ledges, recesses, and overhangs where it varies faster than the slope;
// - outcrops: rock blobs on the ground, in rocky patches (never above the noise at the ground: they do not float);
// - pockets: hollows under the slopes, with a roof of rock above them, so they open on the side of the hill (cave
//   mouths) and stay closed under flat ground.
const LEDGE_SCALE = 1 / 26, LEDGE_SCALE_Z = 1 / 12;
const LEDGE_MAX = 7;                       // displacement (voxels) on the steepest slopes
const OUTCROP_SCALE = 1 / 14, OUTCROP_SCALE_Z = 1 / 12, OUTCROP_THRESHOLD = 0.5;
const OUTCROP_HEIGHT = 10;                 // highest outcrops (voxels above the ground)
const POCKET_SCALE = 1 / 28, POCKET_SCALE_Z = 1 / 14;
const POCKET_THRESHOLD = 0.5;              // on steep slopes; higher on gentler ones, none under flat ground
const POCKET_DEPTH = 12;                   // the pockets stay within this depth below the ground
const POCKET_ROOF = 4;                     // rock above them, from the highest column within FIELD_MARGIN
const FIELD_MARGIN = 3;                    // columns around a box for the slope and the roof of the pockets
const RELIEF_UP = Math.max(LEDGE_MAX, OUTCROP_HEIGHT); // the relief never goes higher above the height map
const RELIEF_DOWN = POCKET_DEPTH;          // nor deeper below it
const RELIEF_TOP = MAX_HEIGHT + 6;         // nor above this (one air voxel left under the top of the world)

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
 * Minecraft-like terrain: a height map (plains, hills, ridged mountain ranges) shaped in 3D near the surface (ledges,
 * recesses and overhangs on the slopes, rock outcrops, cave mouths), with tunnels and caverns underground.
 * Deterministic: the same seed gives the same world in every worker and on the main thread.
 */
export function createGenerator(seed) {
    const heightNoise = createNoise2D(alea(seed + '/height'));
    const mountainNoise = createNoise2D(alea(seed + '/mountains'));
    const rockNoise = createNoise2D(alea(seed + '/rock'));
    const tunnelA = createNoise3D(alea(seed + '/tunnelA'));
    const tunnelB = createNoise3D(alea(seed + '/tunnelB'));
    const cavern = createNoise3D(alea(seed + '/cavern'));
    const CAVE_PARAMS = [[tunnelA, TUNNEL_SCALE, TUNNEL_SCALE_Z], [tunnelB, TUNNEL_SCALE, TUNNEL_SCALE_Z], [cavern, CAVERN_SCALE, CAVERN_SCALE]];
    // relief noises: 0 ledges, 1 outcrops, 2 pockets
    const RELIEF_PARAMS = [
        [createNoise3D(alea(seed + '/ledges')), LEDGE_SCALE, LEDGE_SCALE_Z],
        [createNoise3D(alea(seed + '/outcrops')), OUTCROP_SCALE, OUTCROP_SCALE_Z],
        [createNoise3D(alea(seed + '/pockets')), POCKET_SCALE, POCKET_SCALE_Z],
    ];

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

    /** number of solid voxels above z = 0 in the column (x, y) of the height map (before the 3D relief) */
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

    // interpolated noise at one voxel (same corners and same interpolation as fillChunk and fillRegion)
    function sample(noise, scale, scaleZ, x, y, z) {
        const gx = Math.floor(x / GRID), gy = Math.floor(y / GRID), gz = Math.floor(z / GRID);
        const fx = (x - gx * GRID) / GRID, fy = (y - gy * GRID) / GRID, fz = (z - gz * GRID) / GRID;
        const v = (dx, dy, dz) => gridValue(noise, scale, scaleZ, gx + dx, gy + dy, gz + dz);
        return trilerp(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(1, 1, 0), v(0, 0, 1), v(1, 0, 1), v(0, 1, 1), v(1, 1, 1), fx, fy, fz);
    }

    /**
     * Noise values at the grid points g0 + (i, j, k) of a box of sx x sy x sz points; with bands (2 values per grid column
     * (i, j): first and last k), only these slices.
     */
    function fillGrid(grid, [noise, scale, scaleZ], g0x, g0y, g0z, sx, sy, sz, bands = null) {
        for (let i = 0; i < sx; i++) {
            for (let j = 0; j < sy; j++) {
                const c = i * sy + j;
                const k0 = bands ? Math.max(0, bands[2 * c]) : 0, k1 = bands ? Math.min(sz - 1, bands[2 * c + 1]) : sz - 1;
                let n = c * sz + k0;
                for (let k = k0; k <= k1; k++) grid[n++] = gridValue(noise, scale, scaleZ, g0x + i, g0y + j, g0z + k);
            }
        }
    }

    /**
     * Slices of the relief noises read by the columns of a box (heights index x * ny + y, from wx0, wy0) in a grid of
     * sx x sy columns from g0: each grid column covers the relief band of the voxel columns that interpolate it.
     */
    let bandScratch = new Int32Array(0);
    function reliefBands(heights, wx0, wy0, nx, ny, g0x, g0y, g0z, sx, sy) {
        if (bandScratch.length < 2 * sx * sy) bandScratch = new Int32Array(2 * sx * sy);
        const bands = bandScratch;
        for (let c = 0; c < sx * sy; c++) {
            bands[2 * c] = 0x7fffffff;
            bands[2 * c + 1] = -0x7fffffff;
        }
        for (let x = 0; x < nx; x++) {
            const gx = Math.floor((wx0 + x) / GRID) - g0x;
            for (let y = 0; y < ny; y++) {
                const gy = Math.floor((wy0 + y) / GRID) - g0y, h = heights[x * ny + y];
                const k0 = Math.floor((h - RELIEF_DOWN) / GRID) - g0z, k1 = Math.floor((h + RELIEF_UP) / GRID) + 1 - g0z;
                const c = gx * sy + gy; // the 4 grid columns around the voxel column
                widen(bands, c, k0, k1);
                widen(bands, c + 1, k0, k1);
                widen(bands, c + sy, k0, k1);
                widen(bands, c + sy + 1, k0, k1);
            }
        }
        return bands;
    }
    function widen(bands, c, k0, k1) {
        if (k0 < bands[2 * c]) bands[2 * c] = k0;
        if (k1 > bands[2 * c + 1]) bands[2 * c + 1] = k1;
    }

    // ---------------------------------------------------------------- relief near the surface

    /**
     * Relief parameters of the columns of a box (index x * ny + y): height, ledge amplitude (from the slope), outcrop
     * height (rocky patches), top of the pockets (POCKET_ROOF below the highest column within FIELD_MARGIN, so that on a
     * slope they reach the surface downhill) and their noise threshold (from that rise: 1, no pocket, on flat ground).
     * The last box is kept: the heights of a column task, then its voxels.
     */
    let fieldCache = null;
    function columnField(x0, y0, nx, ny, keep = true) {
        const c = fieldCache;
        if (c && c.x0 === x0 && c.y0 === y0 && c.nx === nx && c.ny === ny) return c;
        const M = FIELD_MARGIN, ex = nx + 2 * M, ey = ny + 2 * M;
        const ext = new Int16Array(ex * ey);
        for (let i = 0; i < ex; i++) {
            for (let j = 0; j < ey; j++) ext[i * ey + j] = surfaceHeight(x0 - M + i, y0 - M + j);
        }
        // highest column within M: along y, then along x
        const along = new Int16Array(ex * ny);
        for (let i = 0; i < ex; i++) {
            for (let j = 0; j < ny; j++) {
                let m = ext[i * ey + j];
                for (let d = 1; d <= 2 * M; d++) m = Math.max(m, ext[i * ey + j + d]);
                along[i * ny + j] = m;
            }
        }
        const n = nx * ny;
        const field = {
            x0, y0, nx, ny, h: new Int16Array(n), ledge: new Float64Array(n), outcrop: new Float64Array(n),
            roof: new Int16Array(n), pocket: new Float64Array(n),
        };
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                const k = i * ny + j, e = (i + M) * ey + (j + M);
                let m = along[k];
                for (let d = 1; d <= 2 * M; d++) m = Math.max(m, along[(i + d) * ny + j]);
                const slope = Math.hypot(ext[e + 2 * ey] - ext[e - 2 * ey], ext[e + 2] - ext[e - 2]) / 4; // voxels per voxel
                field.h[k] = ext[e];
                field.ledge[k] = LEDGE_MAX * smoothstep(1, 3, slope);
                field.outcrop[k] = OUTCROP_HEIGHT * smoothstep(0.05, 0.45, rockNoise((x0 + i) / 230, (y0 + j) / 230));
                field.roof[k] = m - POCKET_ROOF;
                field.pocket[k] = POCKET_THRESHOLD + (1 - POCKET_THRESHOLD) * (1 - smoothstep(2, 6, m - ext[e]));
            }
        }
        if (keep) fieldCache = field;
        return field;
    }

    /**
     * Relief noises that can change the solidity of a voxel of a column (field values): bits 1 ledges, 2 outcrops,
     * 4 pockets. None above h + RELIEF_UP or below h - RELIEF_DOWN. The noises never exceed 1: no pocket at threshold 1.
     */
    function reliefNeeds(z, h, ledge, outcrop, roof, pocket) {
        // (reliefLow must stay below the voxels where this is not 0)
        let needs = 0;
        if (ledge > 0 && z >= h - ledge && z < h + ledge) needs |= 1;
        if (outcrop > 0 && z >= h && z < h + outcrop) needs |= 2;
        // not under the lakes and the beaches
        if (pocket < 1 && z < roof && z >= h - RELIEF_DOWN && h >= SEA_LEVEL + 2) needs |= 4;
        return needs;
    }

    /** lowest voxel of a column where reliefNeeds can be non zero (below: the height map alone) */
    function reliefLow(h, ledge, pocket) {
        if (pocket < 1 && h >= SEA_LEVEL + 2) return h - RELIEF_DOWN;
        return ledge > 0 ? h - ledge : h;
    }

    /**
     * Solidity of a voxel from the relief alone (the caves are carved afterwards), with the noises of reliefNeeds and the
     * outcrop noise at the ground of the column (z = h).
     */
    function reliefSolid(z, h, ledge, outcrop, pocket, needs, ledgeNoise, outcropNoise, pocketNoise, outcropBase) {
        let top = h;
        if (needs & 1) top = h + ledge * ledgeNoise;
        const o = Math.min(outcropNoise, outcropBase);
        if ((needs & 2) && o > OUTCROP_THRESHOLD) { // square root: steep sides, rounded tops
            top = Math.max(top, h + outcrop * Math.sqrt((o - OUTCROP_THRESHOLD) / (1 - OUTCROP_THRESHOLD)));
        }
        if (z >= Math.min(top, RELIEF_TOP)) return false;
        return !((needs & 4) && pocketNoise > pocket);
    }

    /**
     * reliefSolid with the noises interpolated in grids (fillChunk, fillRegion): point gi, strides sx (x) and sy (y),
     * 1 along z. Kept out of the fill loops, so that they keep the cave interpolation inlined.
     */
    function gridReliefSolid(z, h, ledge, outcrop, roof, pocket, outcropBase, grids, gi, sx, sy, fx, fy, fz) {
        const needs = reliefNeeds(z, h, ledge, outcrop, roof, pocket);
        if (needs === 0) return z < h;
        return reliefSolid(z, h, ledge, outcrop, pocket, needs,
            (needs & 1) ? gridAt(grids[3], gi, sx, sy, fx, fy, fz) : 0,
            (needs & 2) ? gridAt(grids[4], gi, sx, sy, fx, fy, fz) : 0,
            (needs & 4) ? gridAt(grids[5], gi, sx, sy, fx, fy, fz) : 0, outcropBase);
    }
    function gridAt(g, gi, sx, sy, fx, fy, fz) {
        return trilerp(g[gi], g[gi + sx], g[gi + sy], g[gi + sx + sy],
            g[gi + 1], g[gi + sx + 1], g[gi + sy + 1], g[gi + sx + sy + 1], fx, fy, fz);
    }

    // ---------------------------------------------------------------- caves

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
        if (z >= h + RELIEF_UP) return 0;
        if (z >= h - RELIEF_DOWN) {
            const f = columnField(x, y, 1, 1, false), ledge = f.ledge[0], outcrop = f.outcrop[0], pocket = f.pocket[0];
            const needs = reliefNeeds(z, h, ledge, outcrop, f.roof[0], pocket);
            const relief = n => (needs & (1 << n)) ? sample(...RELIEF_PARAMS[n], x, y, z) : 0;
            const base = (needs & 2) ? sample(...RELIEF_PARAMS[1], x, y, h) : 0;
            if (!reliefSolid(z, h, ledge, outcrop, pocket, needs, relief(0), relief(1), relief(2), base)) return 0;
            if (z >= h) return 1;
        }
        const a = sample(tunnelA, TUNNEL_SCALE, TUNNEL_SCALE_Z, x, y, z);
        const b = needsB(a) ? sample(tunnelB, TUNNEL_SCALE, TUNNEL_SCALE_Z, x, y, z) : 1;
        const c = needsC(z, h) ? sample(cavern, CAVERN_SCALE, CAVERN_SCALE, x, y, z) : 0;
        return isCave(z, h, a, b, c) ? 0 : 1;
    }

    /** heights of a chunk column and of the columns around it: P x P values, index (x + 1) * P + (y + 1) */
    function columnHeights(cx, cy) {
        return columnField(cx * CHUNK_SIZE - 1, cy * CHUNK_SIZE - 1, P, P).h.slice();
    }

    // grids of fillChunk: 3 cave noises, 3 relief noises. Float64 like the values computed by sample(): solidAt and
    // fillChunk must agree on every voxel
    const grids = Array.from({ length: 6 }, () => new Float64Array(GRID_SPAN ** 3));

    /**
     * Voxels of a padded chunk (index ((x + 1) * P + (y + 1)) * P + (z + 1), 1 = solid) into out.
     * @param heights columnHeights of the chunk column
     * @returns 0 if all air, 1 if all solid, -1 otherwise
     */
    function fillChunk(cx, cy, cz, heights, out) {
        const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE, oz = cz * CHUNK_SIZE;

        let maxHeight = -Infinity;
        for (let i = 0; i < heights.length; i++) maxHeight = Math.max(maxHeight, heights[i]);
        if (oz - 1 >= maxHeight + RELIEF_UP) {
            out.fill(0);
            return 0;
        }
        const field = columnField(ox - 1, oy - 1, P, P);

        // noise grids: points g0 .. g0 + GRID_SPAN - 1 on each axis; the relief ones only near the surface
        const g0x = Math.floor((ox - 1) / GRID), g0y = Math.floor((oy - 1) / GRID), g0z = Math.floor((oz - 1) / GRID);
        const S = GRID_SPAN;
        CAVE_PARAMS.forEach((params, n) => fillGrid(grids[n], params, g0x, g0y, g0z, S, S, S));
        const bands = reliefBands(heights, ox - 1, oy - 1, P, P, g0x, g0y, g0z, S, S);
        RELIEF_PARAMS.forEach((params, n) => fillGrid(grids[3 + n], params, g0x, g0y, g0z, S, S, S, bands));
        const S2 = S * S;
        const [ga, gb, gc] = grids;
        const interpolate = (grid, gi, fx, fy, fz) => trilerp(
            grid[gi], grid[gi + S2], grid[gi + S], grid[gi + S2 + S],
            grid[gi + 1], grid[gi + S2 + 1], grid[gi + S + 1], grid[gi + S2 + S + 1], fx, fy, fz);

        let solid = 0, total = 0;
        for (let x = -1; x <= CHUNK_SIZE; x++) {
            const wx = ox + x;
            const outsideX = wx < WORLD_MIN_XY || wx >= WORLD_MAX_XY;
            const gx = Math.floor(wx / GRID), fx = (wx - gx * GRID) / GRID;
            for (let y = -1; y <= CHUNK_SIZE; y++) {
                const wy = oy + y;
                const outside = outsideX || wy < WORLD_MIN_XY || wy >= WORLD_MAX_XY;
                const k = (x + 1) * P + (y + 1);
                const h = heights[k], ledge = field.ledge[k], outcrop = field.outcrop[k], roof = field.roof[k], pocket = field.pocket[k];
                const top = h + Math.max(ledge, outcrop), low = reliefLow(h, ledge, pocket); // relief between
                const gy = Math.floor(wy / GRID), fy = (wy - gy * GRID) / GRID;
                // outcrop noise at the ground (the same value as the grid would give)
                const base = outcrop > 0 && h + outcrop > oz - 1 && h <= oz + CHUNK_SIZE ? sample(...RELIEF_PARAMS[1], wx, wy, h) : 0;
                let pi = k * P;
                for (let z = -1; z <= CHUNK_SIZE; z++, pi++) {
                    const wz = oz + z;
                    let v = 1;
                    if (wz < WORLD_BOTTOM) {
                        v = 1;
                    } else if (outside || wz >= top) {
                        v = 0;
                    } else {
                        const gz = Math.floor(wz / GRID), fz = (wz - gz * GRID) / GRID;
                        const gi = ((gx - g0x) * S + (gy - g0y)) * S + (gz - g0z);
                        if (wz >= low && !gridReliefSolid(wz, h, ledge, outcrop, roof, pocket, base, grids, gi, S2, S, fx, fy, fz)) {
                            v = 0;
                        } else if (wz < h) {
                            const a = interpolate(ga, gi, fx, fy, fz);
                            const b = needsB(a) ? interpolate(gb, gi, fx, fy, fz) : 1;
                            const c = needsC(wz, h) ? interpolate(gc, gi, fx, fy, fz) : 0;
                            v = isCave(wz, h, a, b, c) ? 0 : 1;
                        }
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

    /** heights of a box of columns: nx x ny values, index x * ny + y */
    function regionHeights(x0, y0, nx, ny) {
        return columnField(x0, y0, nx, ny).h.slice();
    }

    // grids of fillRegion, kept between calls of the same size
    let regionGrids = null, regionGridSize = 0;

    /**
     * Voxels of a box (index (x * ny + y) * nz + z, 1 = solid) into out: the same voxels as fillChunk and solidAt
     * (same noise grid, same interpolation).
     * @param heights regionHeights of the box columns
     */
    function fillRegion(x0, y0, z0, nx, ny, nz, heights, out) {
        let maxHeight = -Infinity;
        for (let i = 0; i < heights.length; i++) maxHeight = Math.max(maxHeight, heights[i]);
        const field = columnField(x0, y0, nx, ny);
        const g0x = Math.floor(x0 / GRID), g0y = Math.floor(y0 / GRID), g0z = Math.floor(z0 / GRID);
        const sx = Math.floor((x0 + nx - 1) / GRID) - g0x + 2, sy = Math.floor((y0 + ny - 1) / GRID) - g0y + 2;
        const zTop = Math.min(z0 + nz - 1, maxHeight - 1 + RELIEF_UP); // highest voxel that can be solid
        const sz = Math.max(Math.floor(zTop / GRID) - g0z + 2, 2);
        const size = sx * sy * sz;
        if (size > regionGridSize) {
            regionGrids = Array.from({ length: 6 }, () => new Float64Array(size));
            regionGridSize = size;
        }
        CAVE_PARAMS.forEach((params, n) => fillGrid(regionGrids[n], params, g0x, g0y, g0z, sx, sy, sz));
        const bands = reliefBands(heights, x0, y0, nx, ny, g0x, g0y, g0z, sx, sy);
        RELIEF_PARAMS.forEach((params, n) => fillGrid(regionGrids[3 + n], params, g0x, g0y, g0z, sx, sy, sz, bands));
        const [ga, gb, gc] = regionGrids;
        const S2 = sy * sz;
        const interpolate = (grid, gi, fx, fy, fz) => trilerp(
            grid[gi], grid[gi + S2], grid[gi + sz], grid[gi + S2 + sz],
            grid[gi + 1], grid[gi + S2 + 1], grid[gi + sz + 1], grid[gi + S2 + sz + 1], fx, fy, fz);

        for (let x = 0; x < nx; x++) {
            const wx = x0 + x;
            const outsideX = wx < WORLD_MIN_XY || wx >= WORLD_MAX_XY;
            const gx = Math.floor(wx / GRID), fx = (wx - gx * GRID) / GRID;
            for (let y = 0; y < ny; y++) {
                const wy = y0 + y;
                const outside = outsideX || wy < WORLD_MIN_XY || wy >= WORLD_MAX_XY;
                const k = x * ny + y;
                const h = heights[k], ledge = field.ledge[k], outcrop = field.outcrop[k], roof = field.roof[k], pocket = field.pocket[k];
                const top = h + Math.max(ledge, outcrop), low = reliefLow(h, ledge, pocket);
                const gy = Math.floor(wy / GRID), fy = (wy - gy * GRID) / GRID;
                const rowBase = ((gx - g0x) * sy + (gy - g0y)) * sz - g0z;
                const gh = Math.floor(h / GRID); // outcrop noise at the ground
                const base = outcrop > 0 ? gridAt(regionGrids[4], rowBase + gh, S2, sz, fx, fy, (h - gh * GRID) / GRID) : 0;
                let pi = k * nz;
                for (let z = 0; z < nz; z++, pi++) {
                    const wz = z0 + z;
                    let v = 1;
                    if (wz < WORLD_BOTTOM) {
                        v = 1;
                    } else if (outside || wz >= top) {
                        v = 0;
                    } else {
                        const gz = Math.floor(wz / GRID), fz = (wz - gz * GRID) / GRID;
                        const gi = rowBase + gz;
                        if (wz >= low && !gridReliefSolid(wz, h, ledge, outcrop, roof, pocket, base, regionGrids, gi, S2, sz, fx, fy, fz)) {
                            v = 0;
                        } else if (wz < h) {
                            const a = interpolate(ga, gi, fx, fy, fz);
                            const b = needsB(a) ? interpolate(gb, gi, fx, fy, fz) : 1;
                            const c = needsC(wz, h) ? interpolate(gc, gi, fx, fy, fz) : 0;
                            v = isCave(wz, h, a, b, c) ? 0 : 1;
                        }
                    }
                    out[pi] = v;
                }
            }
        }
    }

    /** heights every step voxels, n x n samples from (x0, y0), x varying fastest; outside the world: very low */
    function heightGrid(x0, y0, n, step) {
        const grid = new Int16Array(n * n);
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const x = x0 + i * step, y = y0 + j * step;
                const outside = x < WORLD_MIN_XY || x >= WORLD_MAX_XY || y < WORLD_MIN_XY || y >= WORLD_MAX_XY;
                grid[j * n + i] = outside ? WORLD_BOTTOM : surfaceHeight(x, y);
            }
        }
        return grid;
    }

    return { surfaceHeight, solidAt, columnHeights, fillChunk, heightGrid, regionHeights, fillRegion };
}
