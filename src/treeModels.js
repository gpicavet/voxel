import alea from 'alea';
import { FACES } from './mesher';

// Tree models, generated at startup (no file): voxels of TREE_VOXEL (4 times smaller than the terrain voxels),
// meshed once with their ambient occlusion, in 3 levels of detail (voxels of 0.25, 0.5 and 1). The trees of the world
// are instances of them (treePlacement.js, trees.js).

export const TREE_VOXEL = 0.25;
export const TREE_LODS = 3;

// materials, decoded in tree_fragment.glsl
export const BARK = 0, OAK_LEAVES = 1, BIRCH_BARK = 2, NEEDLES = 3, DEAD_WOOD = 4, BIRCH_LEAVES = 5, BUSH_LEAVES = 6;
const WOOD = new Set([BARK, BIRCH_BARK, DEAD_WOOD]);

// species, in the order of treePlacement.js
export const OAK = 0, PINE = 1, BIRCH = 2, BUSH = 3, DEAD = 4;
export const SPECIES_COUNT = 5;

class Grid {
    constructor(nx, ny, nz) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.v = new Uint8Array(nx * ny * nz); // material + 1, 0 = empty
    }
    set(x, y, z, material) {
        x = Math.round(x); y = Math.round(y); z = Math.round(z);
        if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
        this.v[(x * this.ny + y) * this.nz + z] = material + 1;
    }
    setIfEmpty(x, y, z, material) {
        if (this.get(x, y, z) === 0) this.set(x, y, z, material);
    }
    get(x, y, z) {
        if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return 0;
        return this.v[(x * this.ny + y) * this.nz + z];
    }
}

// filled disc of radius r at height z
function disc(grid, cx, cy, z, r, material) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) grid.set(x, y, z, material);
}

// branch: a line of voxels of radius r from a to b
function branch(grid, a, b, r, material) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const steps = Math.ceil(length * 2);
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
            for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
                for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++)
                    if (dx * dx + dy * dy + dz * dz <= r * r + 0.3) grid.set(p[0] + dx, p[1] + dy, p[2] + dz, material);
    }
}

// blob of leaves: ellipsoid with a rough surface (the outer layer is sparse)
function blob(grid, random, c, rx, ry, rz, material, density = 0.75) {
    for (let x = Math.floor(c[0] - rx - 1); x <= Math.ceil(c[0] + rx + 1); x++) {
        for (let y = Math.floor(c[1] - ry - 1); y <= Math.ceil(c[1] + ry + 1); y++) {
            for (let z = Math.floor(c[2] - rz - 1); z <= Math.ceil(c[2] + rz + 1); z++) {
                const d = Math.sqrt(((x - c[0]) / rx) ** 2 + ((y - c[1]) / ry) ** 2 + ((z - c[2]) / rz) ** 2);
                if (d > 1.15) continue;
                const keep = d < 0.8 ? 1 : d < 1.0 ? density : density * 0.35;
                if (random() < keep) grid.setIfEmpty(x, y, z, material);
            }
        }
    }
}

function trunk(grid, cx, cy, height, radius, material, flare = 0) {
    for (let z = 0; z < height; z++) {
        const r = radius + (z < 4 ? flare * (1 - z / 4) : 0);
        disc(grid, cx, cy, z, r, material);
    }
}

function oak(random) {
    const g = new Grid(48, 48, 60);
    const c = 24, trunkHeight = 17 + Math.floor(random() * 4);
    trunk(g, c, c, trunkHeight + 8, 1.7, BARK, 1.2);
    const top = [c, c, trunkHeight + 8];
    for (let i = 0; i < 4; i++) {
        const a = random() * Math.PI * 2;
        branch(g, [c, c, trunkHeight - 2 + i * 2], [c + Math.cos(a) * 9, c + Math.sin(a) * 9, trunkHeight + 8 + random() * 4], 1, BARK);
    }
    blob(g, random, [top[0], top[1], top[2] + 4], 11, 11, 8, OAK_LEAVES);
    for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2 + random();
        const d = 6 + random() * 4;
        blob(g, random, [c + Math.cos(a) * d, c + Math.sin(a) * d, top[2] + random() * 6 - 1], 6 + random() * 3, 6 + random() * 3, 5 + random() * 2, OAK_LEAVES);
    }
    return g;
}

function pine(random) {
    const g = new Grid(36, 36, 72);
    const c = 18, height = 64;
    trunk(g, c, c, height - 4, 1.3, BARK, 0.8);
    // tiers of drooping branches, smaller towards the top
    for (let z = 10; z < height; z++) {
        const level = (z - 10) / (height - 10);
        const tier = ((z - 10) % 7) / 7; // 0 at the bottom of a tier
        const r = 15 * Math.pow(1 - level, 0.9) * (0.55 + 0.45 * (1 - tier)) + 1;
        for (let x = Math.floor(c - r - 1); x <= Math.ceil(c + r + 1); x++) {
            for (let y = Math.floor(c - r - 1); y <= Math.ceil(c + r + 1); y++) {
                const d = Math.hypot(x - c, y - c) / r;
                if (d > 1.1) continue;
                if (random() < (d < 0.75 ? 1 : d < 1 ? 0.7 : 0.25)) g.setIfEmpty(x, y, z, NEEDLES);
            }
        }
    }
    return g;
}

function birch(random) {
    const g = new Grid(30, 30, 58);
    const c = 15, height = 44 + Math.floor(random() * 6);
    trunk(g, c, c, height, 1.0, BIRCH_BARK, 0.5);
    for (let i = 0; i < 4; i++) {
        const a = random() * Math.PI * 2, z = 26 + i * 4;
        branch(g, [c, c, z], [c + Math.cos(a) * 5, c + Math.sin(a) * 5, z + 6], 0.6, BIRCH_BARK);
    }
    blob(g, random, [c, c, height - 6], 7.5, 7.5, 12, BIRCH_LEAVES, 0.65);
    blob(g, random, [c + 3, c - 2, height - 14], 5, 5, 6, BIRCH_LEAVES, 0.6);
    return g;
}

function bush(random) {
    const g = new Grid(26, 26, 16);
    const c = 13;
    for (let i = 0; i < 3; i++) {
        const a = random() * Math.PI * 2;
        branch(g, [c, c, 0], [c + Math.cos(a) * 4, c + Math.sin(a) * 4, 6], 0.6, BARK);
    }
    blob(g, random, [c, c, 6], 10, 9, 6, BUSH_LEAVES, 0.8);
    blob(g, random, [c + 4, c + 3, 4], 6, 6, 4, BUSH_LEAVES, 0.8);
    return g;
}

function dead(random) {
    const g = new Grid(40, 40, 52);
    const c = 20, height = 34;
    trunk(g, c, c, height, 1.5, DEAD_WOOD, 1.0);
    for (let i = 0; i < 6; i++) {
        const a = random() * Math.PI * 2, z = 16 + random() * 16, length = 8 + random() * 8;
        const end = [c + Math.cos(a) * length, c + Math.sin(a) * length, z + 4 + random() * 10];
        branch(g, [c, c, z], end, 0.9, DEAD_WOOD);
        // fork
        const b = a + (random() - 0.5) * 1.5;
        branch(g, end, [end[0] + Math.cos(b) * 4, end[1] + Math.sin(b) * 4, end[2] + 4], 0.5, DEAD_WOOD);
    }
    return g;
}

/** half resolution: a voxel is wood if any child is wood (trunks stay continuous), leaves if 3 of 8 are leaves */
function downsample(grid) {
    const out = new Grid(Math.ceil(grid.nx / 2), Math.ceil(grid.ny / 2), Math.ceil(grid.nz / 2));
    const counts = new Uint8Array(8);
    for (let x = 0; x < out.nx; x++) {
        for (let y = 0; y < out.ny; y++) {
            for (let z = 0; z < out.nz; z++) {
                counts.fill(0);
                let solid = 0, wood = -1;
                for (let i = 0; i < 8; i++) {
                    const m = grid.get(2 * x + (i & 1), 2 * y + ((i >> 1) & 1), 2 * z + (i >> 2));
                    if (m === 0) continue;
                    solid++;
                    counts[m - 1]++;
                    if (WOOD.has(m - 1)) wood = m - 1;
                }
                if (wood >= 0) {
                    out.v[(x * out.ny + y) * out.nz + z] = wood + 1;
                } else if (solid >= 3) {
                    let best = 0;
                    for (let m = 1; m < 8; m++) if (counts[m] > counts[best]) best = m;
                    out.v[(x * out.ny + y) * out.nz + z] = best + 1;
                }
            }
        }
    }
    return out;
}

const LEAVES = new Set([OAK_LEAVES, NEEDLES, BIRCH_LEAVES, BUSH_LEAVES]);

/** per voxel, distance (in voxels) to the outside through the leaves: 1 on the surface, up to 3 */
function leafDepth(grid) {
    const { nx, ny, nz } = grid;
    const depth = new Uint8Array(nx * ny * nz);
    const index = (x, y, z) => (x * ny + y) * nz + z;
    const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let d = 1; d <= 3; d++) {
        for (let x = 0; x < nx; x++) {
            for (let y = 0; y < ny; y++) {
                for (let z = 0; z < nz; z++) {
                    const i = index(x, y, z);
                    if (grid.v[i] === 0 || depth[i] !== 0) continue;
                    // next to the outside (d = 1), or to a voxel of depth d - 1
                    if (NEIGHBORS.some(([dx, dy, dz]) => {
                        const m = grid.get(x + dx, y + dy, z + dz);
                        if (m === 0) return d === 1;
                        return depth[index(x + dx, y + dy, z + dz)] === d - 1 && d > 1;
                    })) depth[i] = d;
                }
            }
        }
    }
    return depth;
}

/**
 * Faces of the voxels next to an empty voxel, with ambient occlusion per corner. Same vertex format as the terrain:
 * x, y, z (7 bits each) | face (3 bits) | ambient occlusion (2 bits) | material (3 bits)
 * cutout (finest level, leaves with transparent gaps): also a second layer of leaves under the surface, and the branches
 * inside the crowns, seen through the gaps.
 */
function meshGrid(grid, cutout) {
    const { nx, ny, nz } = grid;
    const vertices = [];
    const solid = (x, y, z) => grid.get(x, y, z) !== 0;
    const depth = cutout ? leafDepth(grid) : null;
    const depthAt = (x, y, z) => depth[(x * ny + y) * nz + z];
    const visibleAgainst = (m, x, y, z, nxv, nyv, nzv) => {
        const n = grid.get(nxv, nyv, nzv);
        if (n === 0) return true;
        if (!cutout || !LEAVES.has(n - 1)) return false;
        // wood inside the leaves shows through the gaps; second layer of leaves, facing the surface ones
        if (!LEAVES.has(m - 1)) return true;
        return depthAt(x, y, z) === 2 && depthAt(nxv, nyv, nzv) === 1;
    };
    for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
                const m = grid.get(x, y, z);
                if (m === 0) continue;
                FACES.forEach((face, f) => {
                    const [fx, fy, fz] = face.n;
                    if (!visibleAgainst(m, x, y, z, x + fx, y + fy, z + fz)) return;
                    const axis = face.n.findIndex(v => v !== 0);
                    const [u, v] = [0, 1, 2].filter(a => a !== axis);
                    const ao = face.c.map(c => {
                        const du = c[u] ? 1 : -1, dv = c[v] ? 1 : -1;
                        const at = (ou, ov) => {
                            const p = [x + fx, y + fy, z + fz];
                            p[u] += ou;
                            p[v] += ov;
                            return solid(p[0], p[1], p[2]) ? 1 : 0;
                        };
                        const s1 = at(du, 0), s2 = at(0, dv), co = at(du, dv);
                        return (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                    });
                    const start = (ao[0] + ao[2] < ao[1] + ao[3]) ? 1 : 0;
                    for (let j = 0; j < 4; j++) {
                        const k = (start + j) & 3, c = face.c[k];
                        vertices.push(((x + c[0]) | ((y + c[1]) << 7) | ((z + c[2]) << 14) | (f << 21) | (ao[k] << 24) | ((m - 1) << 26)) >>> 0);
                    }
                });
            }
        }
    }
    return new Uint32Array(vertices);
}

/**
 * @returns per species, per level of detail: { vertices, nFaces, origin (model voxels: center of the base), voxelSize, height }
 */
export function buildTreeModels(seed = 'trees') {
    const random = alea(seed + '/models');
    const makers = [oak, pine, birch, bush, dead];
    return makers.map(make => {
        let grid = make(random);
        const center = [grid.nx / 2, grid.ny / 2];
        const lods = [];
        for (let lod = 0; lod < TREE_LODS; lod++) {
            if (lod > 0) grid = downsample(grid);
            const scale = 1 << lod;
            const vertices = meshGrid(grid, lod === 0);
            lods.push({
                vertices,
                nFaces: vertices.length / 4,
                origin: [center[0] / scale, center[1] / scale, 0],
                voxelSize: TREE_VOXEL * scale,
                height: grid.nz * TREE_VOXEL * scale,
            });
        }
        return lods;
    });
}
