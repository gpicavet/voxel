import alea from 'alea';
import { FACES } from './mesher';
import { MODEL_COUNT, MODEL_SPECIES } from './treePlacement';

// Tree models, generated at startup (no file): voxels of TREE_VOXEL (4 times smaller than the terrain voxels),
// meshed once with their ambient occlusion, in 3 levels of detail (voxels of 0.25, 0.5 and 1). The trees of the world
// are instances of them (treePlacement.js, trees.js).

export const TREE_VOXEL = 0.25;
export const TREE_LODS = 3;

// materials, decoded in tree_fragment.glsl
export const BARK = 0, OAK_LEAVES = 1, BIRCH_BARK = 2, NEEDLES = 3, DEAD_WOOD = 4, BIRCH_LEAVES = 5, BUSH_LEAVES = 6, BLOSSOM = 7;
const WOOD = new Set([BARK, BIRCH_BARK, DEAD_WOOD]);
const LEAVES = new Set([OAK_LEAVES, NEEDLES, BIRCH_LEAVES, BUSH_LEAVES, BLOSSOM]);

// A voxel of the grids: material + 1 (0 = empty) in the low 4 bits, variant of the foliage in the bits above (one per pad
// of leaves or spruce branch: lighter, darker... leafTextures.js), so that a tree is not of a single green.
const materialOf = v => (v & 15) - 1;
const variantOf = v => v >> 4;

// variants drawn from their own random numbers: the shapes of the trees stay those of the main random numbers
let variantRandom = null;

/** variant index drawn with the given weights */
function pickVariant(weights) {
    let r = variantRandom() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
    }
    return weights.length - 1;
}

// species and their variants: treePlacement.js (SPECIES_VARIANTS, MODEL_COUNT)

class Grid {
    constructor(nx, ny, nz) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.v = new Uint8Array(nx * ny * nz); // material + 1 | variant << 4, 0 = empty
    }
    set(x, y, z, material, variant = 0) {
        x = Math.round(x); y = Math.round(y); z = Math.round(z);
        if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
        this.v[(x * this.ny + y) * this.nz + z] = (material + 1) | (variant << 4);
    }
    setIfEmpty(x, y, z, material, variant = 0) {
        x = Math.round(x); y = Math.round(y); z = Math.round(z);
        if (this.get(x, y, z) === 0) this.set(x, y, z, material, variant);
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

function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function direction(azimuth, elevation) {
    return [Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)];
}

/**
 * A crooked branch: straight segments whose direction drifts slowly (bends, not noise), radius tapering from r0 to r1.
 * rise pulls it up (> 0) or lets it droop (< 0).
 */
function crooked(grid, random, start, dir, length, r0, r1, { segments = 6, wobble = 0.25, rise = 0, material = BARK } = {}) {
    let p = start.slice(), d = normalize(dir);
    let drift = [(random() - 0.5) * wobble, (random() - 0.5) * wobble, 0];
    const step = length / segments;
    const points = [p.slice()];
    for (let i = 0; i < segments; i++) {
        const r = r0 + (r1 - r0) * (i / segments);
        const next = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step];
        branch(grid, p, next, Math.max(r, 0.5), material);
        points.push(next);
        drift = [drift[0] * 0.6 + (random() - 0.5) * wobble, drift[1] * 0.6 + (random() - 0.5) * wobble, drift[2] * 0.6 + (random() - 0.5) * wobble * 0.5];
        d = normalize([d[0] + drift[0], d[1] + drift[1], d[2] + drift[2] + rise]);
        p = next;
    }
    return { end: p, dir: d, points };
}

/** recursive limbs; the ends of the last ones go to terminals (where the foliage grows) */
function limbs(grid, random, start, dir, length, radius, depth, terminals, opts) {
    const segment = crooked(grid, random, start, dir, length, radius, radius * 0.65,
        { segments: 5, wobble: opts.wobble, rise: opts.rise, material: opts.material });
    if (depth === 0 || radius < 0.7) {
        terminals.push(segment.end);
        return;
    }
    const children = opts.children || (depth >= 2 ? 3 : 2);
    for (let k = 0; k < children; k++) {
        const from = k === 0 ? segment.end : segment.points[Math.floor(2 + random() * (segment.points.length - 2))];
        const azimuth = Math.atan2(segment.dir[1], segment.dir[0]) + (random() - 0.5) * 1.8;
        const elevation = Math.asin(Math.max(-1, Math.min(1, segment.dir[2]))) + (random() - 0.35) * 0.6;
        limbs(grid, random, from, direction(azimuth, elevation), length * (0.55 + random() * 0.2), radius * 0.62, depth - 1, terminals, opts);
    }
    if (opts.padsAlong && depth >= 1) terminals.push(segment.points[Math.floor(segment.points.length * 0.6)]);
}

/**
 * Pad of foliage: flattened, domed on top, flat below, with an irregular outline and an irregular fringe of leaves
 * hanging from its edge (droop voxels at most).
 */
function clumpHash(x, y, z, seed) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440670441) + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function pad(grid, random, c, rx, rz, material, droop, variant, density = 0.85) {
    const harmonics = [random() * 6.28, random() * 6.28, random() * 6.28];
    const seed = Math.floor(random() * 1e9);
    const radiusAt = angle => rx * (1 + 0.18 * Math.sin(3 * angle + harmonics[0]) + 0.12 * Math.sin(5 * angle + harmonics[1]) + 0.08 * Math.sin(2 * angle + harmonics[2]));
    const bottom = c[2] - rz * 0.55;
    for (let x = Math.floor(c[0] - rx * 1.4); x <= Math.ceil(c[0] + rx * 1.4); x++) {
        for (let y = Math.floor(c[1] - rx * 1.4); y <= Math.ceil(c[1] + rx * 1.4); y++) {
            const dx = x + 0.5 - c[0], dy = y + 0.5 - c[1];
            const q = Math.hypot(dx, dy) / radiusAt(Math.atan2(dy, dx));
            if (q > 1.05) continue;
            const height = rz * Math.sqrt(Math.max(0, 1 - q * q)); // dome
            for (let z = Math.floor(bottom); z <= Math.ceil(c[2] + height); z++) {
                const above = z + 0.5 - c[2];
                if (above > height || z + 0.5 < bottom) continue;
                const edge = Math.max(q, above / Math.max(height, 0.5));
                // solid core (the texture of the foliage has the holes); ragged outer layer made of whole clumps of
                // 2 x 2 x 2 voxels (like leaf blocks), not of scattered voxels
                if (edge < 0.8 || clumpHash(x >> 1, y >> 1, z >> 1, seed) < density * 0.7) grid.setIfEmpty(x, y, z, material, variant);
            }
            // hanging fringe near the edge, by clumps of 2 x 2 columns
            if (q > 0.6 && clumpHash(x >> 1, y >> 1, 7, seed) < 0.4) {
                const hang = 1 + Math.floor(clumpHash(x >> 1, y >> 1, 9, seed) * droop);
                for (let z = Math.floor(bottom) - 1; z >= Math.floor(bottom) - hang; z--) grid.setIfEmpty(x, y, z, material, variant);
            }
        }
    }
}

/** roots spreading from the base, partly in the ground */
function roots(grid, random, base, count, length, radius, material) {
    for (let i = 0; i < count; i++) {
        const azimuth = (i / count) * Math.PI * 2 + random() * 0.8;
        crooked(grid, random, [base[0], base[1], 3], [Math.cos(azimuth), Math.sin(azimuth), -0.45], length * (0.7 + random() * 0.5), radius, 0.6,
            { segments: 3, wobble: 0.3, material });
    }
}

const GRID = [124, 124, 100];
const C = 62;

function broadleaf(random, p) {
    const g = new Grid(...GRID);
    const lean = [(random() - 0.5) * p.lean, (random() - 0.5) * p.lean, 1];
    const trunk = crooked(g, random, [C, C, 0], lean, p.trunkLength, p.trunkRadius, p.trunkRadius * 0.7,
        { segments: 6, wobble: p.trunkWobble, rise: 0.05, material: p.bark });
    if (p.roots) roots(g, random, [C, C], p.roots, p.trunkRadius * 2.2, p.trunkRadius * 0.6, p.bark);
    const terminals = [trunk.end];
    const start = Math.floor(trunk.points.length * p.limbStart);
    const azimuth0 = random() * Math.PI * 2;
    for (let i = 0; i < p.limbs; i++) {
        const from = trunk.points[Math.min(trunk.points.length - 1, start + Math.floor(random() * (trunk.points.length - start)))];
        const azimuth = azimuth0 + (i / p.limbs) * Math.PI * 2 + (random() - 0.5) * 0.7;
        const elevation = p.elevation[0] + random() * (p.elevation[1] - p.elevation[0]);
        limbs(g, random, from, direction(azimuth, elevation), p.limbLength * (0.8 + random() * 0.4), p.trunkRadius * p.limbRadius,
            p.depth, terminals, { wobble: p.limbWobble, rise: p.rise, material: p.bark, padsAlong: p.padsAlong, children: p.children });
    }
    if (p.leaves !== null) {
        for (const t of terminals) {
            const rx = p.pad[0] + random() * (p.pad[1] - p.pad[0]);
            pad(g, random, [t[0], t[1], t[2] + 1], rx, p.padHeight * (0.8 + random() * 0.4), p.leaves, p.droop, pickVariant(p.variants));
        }
    }
    return { grid: g, base: [C, C] };
}

// weights of the foliage variants of the pads (leafTextures.js): oak medium, fresh and dark green; birch and bush light and
// medium; blossom pink, pale pink and deep rose
const OAK_VARIANTS = [0.45, 0.33, 0.22], LIGHT_VARIANTS = [0.6, 0.4], BLOSSOM_VARIANTS = [0.5, 0.35, 0.15];

// variants of each species: see SPECIES_VARIANTS of treePlacement.js
const OAKS = [
    // grand oak: wide spreading crown of many pads
    { trunkLength: 20, trunkRadius: 3.2, trunkWobble: 0.18, lean: 0.25, roots: 5, limbs: 5, limbStart: 0.55, elevation: [0.25, 0.75],
        limbLength: 20, limbRadius: 0.55, limbWobble: 0.3, rise: 0.035, depth: 2, children: 2, padsAlong: true, pad: [6.5, 9], padHeight: 3.4, droop: 3,
        bark: BARK, leaves: OAK_LEAVES, variants: OAK_VARIANTS },
    // smaller oak
    { trunkLength: 16, trunkRadius: 2.4, trunkWobble: 0.22, lean: 0.35, roots: 4, limbs: 4, limbStart: 0.5, elevation: [0.35, 0.85],
        limbLength: 15, limbRadius: 0.55, limbWobble: 0.32, rise: 0.04, depth: 2, children: 2, padsAlong: true, pad: [5, 7], padHeight: 3, droop: 3,
        bark: BARK, leaves: OAK_LEAVES, variants: OAK_VARIANTS },
    // tall oak, steeper limbs
    { trunkLength: 26, trunkRadius: 2.6, trunkWobble: 0.15, lean: 0.2, roots: 4, limbs: 5, limbStart: 0.6, elevation: [0.7, 1.15],
        limbLength: 14, limbRadius: 0.5, limbWobble: 0.28, rise: 0.03, depth: 2, children: 2, padsAlong: true, pad: [5, 7], padHeight: 3.2, droop: 2,
        bark: BARK, leaves: OAK_LEAVES, variants: OAK_VARIANTS },
];
const BIRCHES = [
    { trunkLength: 40, trunkRadius: 1.3, trunkWobble: 0.12, lean: 0.25, roots: 0, limbs: 6, limbStart: 0.45, elevation: [0.75, 1.2],
        limbLength: 9, limbRadius: 0.6, limbWobble: 0.3, rise: 0.02, depth: 1, padsAlong: true, pad: [3, 4.5], padHeight: 3, droop: 4,
        bark: BIRCH_BARK, leaves: BIRCH_LEAVES, variants: LIGHT_VARIANTS },
    { trunkLength: 32, trunkRadius: 1.1, trunkWobble: 0.18, lean: 0.4, roots: 0, limbs: 5, limbStart: 0.4, elevation: [0.6, 1.1],
        limbLength: 8, limbRadius: 0.65, limbWobble: 0.32, rise: 0.02, depth: 1, padsAlong: true, pad: [2.8, 4], padHeight: 2.8, droop: 4,
        bark: BIRCH_BARK, leaves: BIRCH_LEAVES, variants: LIGHT_VARIANTS },
];
const BUSHES = [
    { trunkLength: 3, trunkRadius: 1.0, trunkWobble: 0.3, lean: 0.6, roots: 0, limbs: 4, limbStart: 0.0, elevation: [0.25, 0.7],
        limbLength: 6, limbRadius: 0.8, limbWobble: 0.35, rise: 0.02, depth: 1, padsAlong: false, pad: [4, 5.5], padHeight: 2.6, droop: 1,
        bark: BARK, leaves: BUSH_LEAVES, variants: LIGHT_VARIANTS },
    { trunkLength: 2, trunkRadius: 0.9, trunkWobble: 0.3, lean: 0.6, roots: 0, limbs: 3, limbStart: 0.0, elevation: [0.3, 0.8],
        limbLength: 5, limbRadius: 0.8, limbWobble: 0.35, rise: 0.02, depth: 1, padsAlong: false, pad: [3.5, 5], padHeight: 2.4, droop: 1,
        bark: BARK, leaves: BUSH_LEAVES, variants: LIGHT_VARIANTS },
];
const BLOSSOMS = [
    // wide, low crown of round clumps on spreading limbs
    { trunkLength: 14, trunkRadius: 2.8, trunkWobble: 0.25, lean: 0.35, roots: 4, limbs: 5, limbStart: 0.5, elevation: [0.15, 0.55],
        limbLength: 18, limbRadius: 0.55, limbWobble: 0.35, rise: 0.05, depth: 2, children: 2, padsAlong: true, pad: [5.5, 7.5], padHeight: 4.2, droop: 2,
        bark: BARK, leaves: BLOSSOM, variants: BLOSSOM_VARIANTS },
    // smaller, more upright
    { trunkLength: 11, trunkRadius: 2.2, trunkWobble: 0.3, lean: 0.45, roots: 3, limbs: 4, limbStart: 0.45, elevation: [0.25, 0.75],
        limbLength: 14, limbRadius: 0.55, limbWobble: 0.35, rise: 0.05, depth: 2, children: 2, padsAlong: true, pad: [4.5, 6.5], padHeight: 3.8, droop: 2,
        bark: BARK, leaves: BLOSSOM, variants: BLOSSOM_VARIANTS },
];
const DEADS = [
    { trunkLength: 26, trunkRadius: 2.4, trunkWobble: 0.3, lean: 0.4, roots: 4, limbs: 5, limbStart: 0.45, elevation: [0.3, 1.0],
        limbLength: 16, limbRadius: 0.5, limbWobble: 0.45, rise: 0.03, depth: 2, padsAlong: false, pad: [0, 0], padHeight: 0, droop: 0,
        bark: DEAD_WOOD, leaves: null },
    { trunkLength: 20, trunkRadius: 2.0, trunkWobble: 0.4, lean: 0.6, roots: 3, limbs: 3, limbStart: 0.5, elevation: [0.4, 1.1],
        limbLength: 12, limbRadius: 0.55, limbWobble: 0.5, rise: 0.02, depth: 1, padsAlong: false, pad: [0, 0], padHeight: 0, droop: 0,
        bark: DEAD_WOOD, leaves: null },
];

/**
 * One branch of a spruce: a flat shelf of needles from the trunk outwards, narrowing towards the tip, bending down to the
 * sides and drooping more and more towards the tip (more for the low branches), with a hanging tip.
 */
function spruceBranch(g, random, start, azimuth, length, level) {
    const variant = pickVariant(LIGHT_VARIANTS);
    const dir = [Math.cos(azimuth), Math.sin(azimuth)], side = [-Math.sin(azimuth), Math.cos(azimuth)];
    const droop = 0.18 + (1 - level) * 0.32;
    let z = start[2];
    let tip = start;
    for (let s = 1; s <= length; s++) {
        const t = s / length;
        z -= droop * t * 1.4;
        const px = start[0] + dir[0] * s, py = start[1] + dir[1] * s;
        if (t < 0.45) g.set(px, py, z, BARK); // woody twig near the trunk
        const width = 0.6 + 1.9 * (1 - t);
        for (let w = -Math.ceil(width); w <= Math.ceil(width); w++) {
            if (Math.abs(w) > width + (random() - 0.5) * 0.6) continue;
            const qx = px + side[0] * w, qy = py + side[1] * w, qz = z - Math.abs(w) * 0.4;
            g.setIfEmpty(qx, qy, qz, NEEDLES, variant);
            if (Math.abs(w) < width * 0.7 && random() < 0.85) g.setIfEmpty(qx, qy, qz + 1, NEEDLES, variant); // thicker shelf
        }
        tip = [px, py, z];
    }
    const hang = 1 + Math.floor(random() * (1 + (1 - level) * 2));
    for (let k = 1; k <= hang; k++) g.setIfEmpty(tip[0], tip[1], tip[2] - k, NEEDLES, variant);
}

/** spruce: slightly crooked trunk ending in a bare spire, whorls of separate drooping branches, a narrow cone */
function pine(random, variant) {
    const g = new Grid(...GRID);
    const height = variant === 0 ? 68 : 54;
    const trunk = crooked(g, random, [C, C, 0], [(random() - 0.5) * 0.1, (random() - 0.5) * 0.1, 1], height, 1.6, 0.5,
        { segments: 8, wobble: 0.05, rise: 0.05, material: BARK });
    const centerAt = z => {
        for (let i = 1; i < trunk.points.length; i++) {
            const a = trunk.points[i - 1], b = trunk.points[i];
            if (b[2] >= z) {
                const t = (z - a[2]) / Math.max(b[2] - a[2], 1e-3);
                return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            }
        }
        const last = trunk.points[trunk.points.length - 1];
        return [last[0], last[1]];
    };
    const foliageTop = height - 7; // the spire stays bare
    let z = 8 + Math.floor(random() * 3);
    while (z < foliageTop) {
        const level = (z - 8) / (foliageTop - 8); // 0 at the bottom, 1 at the top
        const length = 3 + 17 * Math.pow(1 - level, 1.05);
        const count = 5 + Math.floor(random() * 3);
        const azimuth0 = random() * Math.PI * 2;
        const [cx, cy] = centerAt(z);
        for (let i = 0; i < count; i++) {
            const azimuth = azimuth0 + (i / count) * Math.PI * 2 + (random() - 0.5) * 0.6;
            spruceBranch(g, random, [cx, cy, z], azimuth, length * (0.75 + random() * 0.45), level);
        }
        z += 3 + Math.floor(random() * 2) + (level < 0.35 ? 1 : 0);
    }
    // small tuft around the base of the spire
    const [tx, ty] = centerAt(foliageTop);
    for (let k = 0; k < 3; k++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.setIfEmpty(tx + dx, ty + dy, foliageTop + k, NEEDLES);
    return { grid: g, base: [C, C] };
}

/** smallest grid holding the voxels and the base */
function crop(model) {
    const { grid, base } = model;
    let x0 = base[0], y0 = base[1], x1 = base[0], y1 = base[1], z1 = 0;
    for (let x = 0; x < grid.nx; x++) {
        for (let y = 0; y < grid.ny; y++) {
            for (let z = 0; z < grid.nz; z++) {
                if (grid.v[(x * grid.ny + y) * grid.nz + z] === 0) continue;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                z1 = Math.max(z1, z);
            }
        }
    }
    const out = new Grid(Math.min(x1 - x0 + 1, 127), Math.min(y1 - y0 + 1, 127), Math.min(z1 + 1, 127));
    for (let x = 0; x < out.nx; x++)
        for (let y = 0; y < out.ny; y++)
            for (let z = 0; z < out.nz; z++)
                out.v[(x * out.ny + y) * out.nz + z] = grid.v[((x + x0) * grid.ny + (y + y0)) * grid.nz + z];
    return { grid: out, base: [base[0] + 0.5 - x0, base[1] + 0.5 - y0] };
}

/**
 * Coarser level of detail, straight from the finest grid (blocks of f x f x f voxels): wood when at least woodMin voxels
 * of the block are wood (any at the first level, so the trunks and limbs stay continuous; a sizeable part further, so the
 * thin twigs do not turn into big blocks of wood over the foliage), else leaves when at least leafMin are leaves
 * (thresholds measured to keep the projected area of the foliage, see the commit message), of the most common kind.
 */
function downsample(grid, f, leafMin, woodMin) {
    const out = new Grid(Math.ceil(grid.nx / f), Math.ceil(grid.ny / f), Math.ceil(grid.nz / f));
    const counts = new Uint16Array(256);
    for (let x = 0; x < out.nx; x++) {
        for (let y = 0; y < out.ny; y++) {
            for (let z = 0; z < out.nz; z++) {
                counts.fill(0);
                let leaves = 0, wood = 0, woodKind = 0;
                for (let i = 0; i < f; i++) {
                    for (let j = 0; j < f; j++) {
                        for (let k = 0; k < f; k++) {
                            const m = grid.get(f * x + i, f * y + j, f * z + k);
                            if (m === 0) continue;
                            if (WOOD.has(materialOf(m))) {
                                wood++;
                                woodKind = m;
                            } else {
                                leaves++;
                                counts[m]++;
                            }
                        }
                    }
                }
                let value = 0;
                if (wood >= woodMin) {
                    value = woodKind;
                } else if (leaves >= leafMin) {
                    let best = 0;
                    for (let m = 1; m < 256; m++) if (counts[m] > counts[best]) best = m;
                    value = best;
                } else if (wood > 0 && leaves === 0) {
                    value = woodKind; // a branch alone in the air
                }
                out.v[(x * out.ny + y) * out.nz + z] = value;
            }
        }
    }
    return out;
}

// per level of detail after the first: [leaves, wood] thresholds of downsample
const LOD_THRESHOLDS = [null, [2, 1], [8, 6]];

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

// directions of the sky openness rays: cosine distributed over the upper hemisphere (the sky lights from above)
const OPENNESS_RAYS = 20;
const OPENNESS_DIRS = (() => {
    const dirs = [];
    for (let i = 0; i < OPENNESS_RAYS; i++) {
        const u = (i + 0.5) / OPENNESS_RAYS, phi = i * 2.399963; // golden angle
        const r = Math.sqrt(u);
        dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)]);
    }
    return dirs;
})();

/**
 * Sky openness of the voxels (computed on demand): the part of the sky seen from the voxel center through the tree
 * itself. Wood stops the rays, each voxel of leaves lets leafTransmittance through (the holes of the foliage).
 */
function opennessField(grid, leafTransmittance) {
    const { nx, ny, nz } = grid;
    const cache = new Float32Array(nx * ny * nz).fill(-1);
    return (x, y, z) => {
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 1;
        const i = (x * ny + y) * nz + z;
        if (cache[i] >= 0) return cache[i];
        let sum = 0;
        for (const [dx, dy, dz] of OPENNESS_DIRS) {
            let t = 1, px = x + 0.5, py = y + 0.5, pz = z + 0.5;
            let last = i;
            for (;;) {
                px += dx * 0.9; py += dy * 0.9; pz += dz * 0.9;
                const vx = Math.floor(px), vy = Math.floor(py), vz = Math.floor(pz);
                if (vx < 0 || vy < 0 || vx >= nx || vy >= ny || vz >= nz) break; // out of the tree: open sky
                const j = (vx * ny + vy) * nz + vz;
                if (j === last) continue;
                last = j;
                const m = grid.v[j];
                if (m === 0) continue;
                if (!LEAVES.has(materialOf(m))) { t = 0; break; }
                t *= leafTransmittance;
                if (t < 0.02) { t = 0; break; }
            }
            sum += t;
        }
        return cache[i] = sum / OPENNESS_RAYS;
    };
}

/**
 * Faces of the voxels next to an empty voxel, with ambient occlusion per corner. Two words per vertex: the vertex format
 * of the terrain, x, y, z (7 bits each) | face (3 bits) | ambient occlusion (2 bits) | material (3 bits) | sky openness
 * (3 bits): the part of the sky seen through the tree itself (baked self occlusion: inside and under the crown, the trunk
 * under it); then the variant of the foliage (2 bits) | fringe (1 bit) | side of the corner along the two axes of the
 * face (1 bit each) | the fringe grows along each axis at this corner (1 bit each).
 * At the finest level, the faces of leaves on the outside along an edge of the foliage (nothing beside them) get a
 * fringe: the same quad, pushed out and grown towards those edges by the vertex shader (tree_vertex.glsl), with sparse
 * leaves that thin out towards its border (tree_surface.glsl): the outline of the foliage is made of leaves, not of the
 * edges of the voxels.
 * cutout (finest level, foliage with transparent holes): also a second layer of leaves under the surface, and the
 * branches inside the crowns, seen through the holes.
 */
function meshGrid(grid, cutout, leafTransmittance) {
    const { nx, ny, nz } = grid;
    const vertices = [], fringes = []; // the fringe faces after the others: drawn for the nearest trees only (trees.js)
    const solid = (x, y, z) => grid.get(x, y, z) !== 0;
    const wood = (x, y, z) => { const m = grid.get(x, y, z); return m !== 0 && !LEAVES.has(materialOf(m)); };
    const openness = opennessField(grid, leafTransmittance);
    const depth = cutout ? leafDepth(grid) : null;
    const depthAt = (x, y, z) => depth[(x * ny + y) * nz + z];
    const visibleAgainst = (m, x, y, z, nxv, nyv, nzv) => {
        const n = grid.get(nxv, nyv, nzv);
        if (n === 0) return true;
        if (!cutout || !LEAVES.has(materialOf(n))) return false;
        // wood inside the leaves shows through the holes; second layer of leaves, facing the surface ones
        // (measured faster than drawing the foliage double sided)
        if (!LEAVES.has(materialOf(m))) return true;
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
                    const sky = [];
                    const ao = face.c.map(c => {
                        const du = c[u] ? 1 : -1, dv = c[v] ? 1 : -1;
                        const cell = (ou, ov) => {
                            const p = [x + fx, y + fy, z + fz];
                            p[u] += ou;
                            p[v] += ov;
                            return p;
                        };
                        const at = (ou, ov) => { const p = cell(ou, ov); return solid(p[0], p[1], p[2]) ? 1 : 0; };
                        const s1 = at(du, 0), s2 = at(0, dv), co = at(du, dv);
                        // smooth openness per corner: mean of the voxels around it that are not wood
                        let sum = 0, n = 0;
                        for (const [ou, ov] of [[0, 0], [du, 0], [0, dv], [du, dv]]) {
                            const p = cell(ou, ov);
                            if (wood(p[0], p[1], p[2])) continue;
                            sum += openness(p[0], p[1], p[2]);
                            n++;
                        }
                        sky.push(n > 0 ? Math.round(sum / n * 7) : 0);
                        return (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                    });
                    const start = (ao[0] + ao[2] < ao[1] + ao[3]) ? 1 : 0;
                    // edges of the foliage beside this face, on each side along u and v: nothing next to the voxel there
                    const beside = (axis2, side) => {
                        const p = [x, y, z];
                        p[axis2] += side;
                        return grid.get(p[0], p[1], p[2]) === 0;
                    };
                    let fringe = cutout && LEAVES.has(materialOf(m)) && grid.get(x + fx, y + fy, z + fz) === 0;
                    const edges = fringe ? [beside(u, -1), beside(u, 1), beside(v, -1), beside(v, 1)] : null;
                    if (fringe && !edges.some(e => e)) fringe = false;
                    for (let quad = 0; quad < (fringe ? 2 : 1); quad++) {
                        for (let j = 0; j < 4; j++) {
                            const k = (start + j) & 3, c = face.c[k];
                            const grow = quad === 1 ? (edges[c[u]] ? 32 : 0) | (edges[2 + c[v]] ? 64 : 0) : 0;
                            (quad === 1 ? fringes : vertices).push(((x + c[0]) | ((y + c[1]) << 7) | ((z + c[2]) << 14) | (f << 21) | (ao[k] << 24) | (materialOf(m) << 26) | (sky[k] << 29)) >>> 0,
                                variantOf(m) | (quad << 2) | (c[u] << 3) | (c[v] << 4) | grow);
                        }
                    }
                });
            }
        }
    }
    return { vertices: new Uint32Array(vertices.concat(fringes)), nFringe: fringes.length / 8 };
}

/** extent of the foliage (meters, from the base): radius, bottom and top, for the canopy map (canopy.js) */
function crownOf(grid, cx, cy, voxelSize) {
    let radius = 0, bottom = Infinity, top = 0;
    for (let x = 0; x < grid.nx; x++) {
        for (let y = 0; y < grid.ny; y++) {
            for (let z = 0; z < grid.nz; z++) {
                const m = grid.v[(x * grid.ny + y) * grid.nz + z];
                if (m === 0 || !LEAVES.has(materialOf(m))) continue;
                radius = Math.max(radius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
                bottom = Math.min(bottom, z);
                top = Math.max(top, z + 1);
            }
        }
    }
    if (bottom === Infinity) return null; // no foliage (dead tree)
    return { radius: radius * voxelSize * 0.85, bottom: bottom * voxelSize, top: top * voxelSize };
}

/**
 * @returns per model (species and variant, see treePlacement.js), per level of detail:
 * { vertices, nFaces, nFringe, origin (model voxels: center of the base), voxelSize, height, crown }
 */
export function buildTreeModels(seed = 'trees') {
    const random = alea(seed + '/models');
    variantRandom = alea(seed + '/variants');
    const variants = [OAKS, null, BIRCHES, BUSHES, DEADS, BLOSSOMS];
    const count = [0, 0, 0, 0, 0, 0];
    const models = [];
    for (let m = 0; m < MODEL_COUNT; m++) {
        const species = MODEL_SPECIES[m], variant = count[species]++;
        const { grid: finest, base } = crop(species === 1 ? pine(random, variant) : broadleaf(random, variants[species][variant]));
        const lods = [];
        for (let lod = 0; lod < TREE_LODS; lod++) {
            const scale = 1 << lod;
            const grid = lod === 0 ? finest : downsample(finest, scale, ...LOD_THRESHOLDS[lod]);
            // bigger voxels of leaves block more of the sky
            const { vertices, nFringe } = meshGrid(grid, lod === 0, Math.pow(0.45, scale));
            lods.push({
                crown: crownOf(grid, base[0] / scale, base[1] / scale, TREE_VOXEL * scale),
                vertices,
                nFaces: vertices.length / 8 - nFringe, // then nFringe faces of fringe
                nFringe,
                origin: [base[0] / scale, base[1] / scale, 0],
                voxelSize: TREE_VOXEL * scale,
                height: grid.nz * TREE_VOXEL * scale,
            });
        }
        models.push(lods);
    }
    return models;
}
