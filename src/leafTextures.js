import alea from 'alea';

// Foliage: pixel art textures of 32 x 32 texels, each covering a meter of a face of leaves (tree_surface.glsl), so
// that the leaves read as leaves and the voxels of 0.25 do not show: leaves of a few texels, lit from the top left with
// a darker outline and midrib, overlapping, with transparent holes between them (the finest level of detail cuts them
// out; further, the foliage is full and the holes keep a dark green, close to the shaded leaves behind). One layer per
// foliage and variant (the pads of a tree have different variants, treeModels.js):
//   0-2 oak: medium, fresh and dark green; 3-4 needles (spruce): dark and lighter; 5-6 birch: light and fresher;
//   7-8 bush: medium and lighter; 9-11 blossom: pink, pale pink and deep rose (LEAF_BASE, LEAF_VARIANTS of
//   tree_surface.glsl)
// A second texture gives the motion of each leaf in the wind (tree_surface.glsl): per texel, the phase, the amplitude
// and the speed of the leaf it belongs to.

const SIZE = 32;

// palettes in sRGB: lit side of the leaves, shaded side, holes
const FOLIAGES = [
    { shape: 'broad', light: [0.42, 0.62, 0.20], dark: [0.12, 0.26, 0.07], hole: [0.07, 0.15, 0.05] },
    { shape: 'broad', light: [0.64, 0.78, 0.25], dark: [0.25, 0.42, 0.10], hole: [0.12, 0.22, 0.06] },
    { shape: 'broad', light: [0.30, 0.50, 0.30], dark: [0.07, 0.19, 0.12], hole: [0.05, 0.12, 0.07] },
    { shape: 'needles', light: [0.36, 0.52, 0.24], dark: [0.09, 0.21, 0.10], hole: [0.06, 0.13, 0.06] },
    { shape: 'needles', light: [0.44, 0.62, 0.32], dark: [0.12, 0.27, 0.14], hole: [0.07, 0.15, 0.08] },
    { shape: 'small', light: [0.62, 0.74, 0.30], dark: [0.26, 0.40, 0.12], hole: [0.16, 0.25, 0.08] },
    { shape: 'small', light: [0.68, 0.78, 0.36], dark: [0.30, 0.45, 0.15], hole: [0.17, 0.27, 0.09] },
    { shape: 'round', light: [0.30, 0.48, 0.15], dark: [0.09, 0.20, 0.05], hole: [0.06, 0.13, 0.04] },
    { shape: 'round', light: [0.40, 0.58, 0.20], dark: [0.12, 0.26, 0.07], hole: [0.07, 0.16, 0.05] },
    { shape: 'flowers', light: [1.00, 0.70, 0.80], dark: [0.80, 0.36, 0.50], hole: [0.45, 0.18, 0.26] },
    { shape: 'flowers', light: [1.00, 0.84, 0.88], dark: [0.88, 0.52, 0.62], hole: [0.52, 0.27, 0.33] },
    { shape: 'flowers', light: [0.92, 0.36, 0.48], dark: [0.56, 0.12, 0.24], hole: [0.32, 0.07, 0.14] },
];
const LAYERS = FOLIAGES.length;

// leaves of each shape: count of tries, coverage to reach, length and width in texels
const SHAPES = {
    broad: { coverage: 0.78, length: [5, 8], width: [3, 4.5] },
    small: { coverage: 0.68, length: [4, 6], width: [2.5, 3.5] },
    round: { coverage: 0.84, length: [4, 6], width: [3.5, 4.5] },
};

function makeLayer(random, { shape, light, dark, hole }) {
    const rgba = new Float32Array(SIZE * SIZE * 4);
    const motion = new Float32Array(SIZE * SIZE * 4).fill(0.5);
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // holes: seen only on the full foliage of the far levels of detail, close to the shaded leaves behind them
    const holeColor = mix(hole, dark, 0.6);
    for (let i = 0; i < SIZE * SIZE; i++) rgba.set([...holeColor, 0], i * 4);
    let clump = null; // phase, amplitude, speed of the leaf being drawn
    let covered = 0;
    const set = (x, y, shade) => {
        const t = ((y % SIZE) + SIZE) % SIZE * SIZE + ((x % SIZE) + SIZE) % SIZE, i = t * 4;
        if (rgba[i + 3] === 0) covered++;
        const c = mix(dark, light, Math.min(1, Math.max(0, shade)));
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 1;
        motion[i] = clump[0]; motion[i + 1] = clump[1]; motion[i + 2] = clump[2]; motion[i + 3] = 1;
    };
    const newClump = () => { clump = [random(), 0.5 + random() * 0.5, random()]; };

    if (shape === 'needles') {
        // tufts of needles: thin strokes from a center, darker at the base
        for (let k = 0; k < 400 && covered < 0.8 * SIZE * SIZE; k++) {
            const cx = random() * SIZE, cy = random() * SIZE, base = random() * 0.4;
            newClump();
            const n = 5 + Math.floor(random() * 4), a0 = random() * Math.PI * 2;
            for (let j = 0; j < n; j++) {
                const a = a0 + (j / n) * Math.PI * 2 + (random() - 0.5) * 0.5, length = 3 + random() * 3.5;
                for (let s = 0; s <= length * 2; s++) {
                    const t = s / (length * 2);
                    // lit towards the top left (texture y is up)
                    set(Math.floor(cx + Math.cos(a) * t * length), Math.floor(cy + Math.sin(a) * t * length),
                        base + 0.55 * t + 0.15 * (Math.sin(a) - Math.cos(a)) / 2);
                }
            }
        }
    } else if (shape === 'flowers') {
        // blossoms: five round petals around a darker heart, in dense clusters
        for (let k = 0; k < 400 && covered < 0.86 * SIZE * SIZE; k++) {
            const cx = random() * SIZE, cy = random() * SIZE, base = 0.35 + random() * 0.4;
            newClump();
            const a0 = random() * Math.PI * 2, r = 1.4 + random() * 0.6;
            for (let j = 0; j < 5; j++) {
                const a = a0 + j * Math.PI * 0.4, px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const d = Math.hypot(dx + 0.5 - (px % 1), dy + 0.5 - (py % 1));
                        if (d > 1.35) continue;
                        // each petal lit from the top left, darker towards the heart
                        set(Math.floor(px) + dx, Math.floor(py) + dy, base + 0.3 * (dy - dx) / 3 + 0.25 * (d / 1.35) - 0.1);
                    }
                }
            }
            set(Math.floor(cx), Math.floor(cy), base - 0.55);
        }
    } else {
        // leaves: pointed ovals, mostly along the diagonals, each lit from the top left, with a darker outline and midrib
        const { coverage, length: [l0, l1], width: [w0, w1] } = SHAPES[shape];
        for (let k = 0; k < 600 && covered < coverage * SIZE * SIZE; k++) {
            const cx = random() * SIZE, cy = random() * SIZE;
            const angle = (Math.floor(random() * 4) + 0.5) * Math.PI / 2 + (random() - 0.5) * 0.9;
            const length = l0 + random() * (l1 - l0), width = w0 + random() * (w1 - w0);
            const base = 0.25 + random() * 0.5;
            const ca = Math.cos(angle), sa = Math.sin(angle);
            newClump();
            const reach = Math.ceil(length / 2) + 1;
            for (let dy = -reach; dy <= reach; dy++) {
                for (let dx = -reach; dx <= reach; dx++) {
                    const x = Math.floor(cx) + dx + 0.5 - cx, y = Math.floor(cy) + dy + 0.5 - cy;
                    const u = (x * ca + y * sa) / (length / 2), v = (-x * sa + y * ca) / (width / 2);
                    if (Math.abs(u) > 1) continue;
                    const half = Math.pow(1 - u * u, 0.6); // pointed at both ends
                    if (Math.abs(v) > half) continue;
                    const edge = Math.abs(v) / Math.max(half, 1e-3);
                    let shade = base + 0.35 * (y - x) / length; // lighter towards the top left
                    if (edge > 0.75) shade -= 0.22;              // outline
                    else if (Math.abs(v) < 0.18) shade -= 0.1;   // midrib
                    set(Math.floor(cx) + dx, Math.floor(cy) + dy, shade);
                }
            }
        }
    }
    return { rgba, motion };
}

function createArray(gl, unit, data, srgb, mipmaps) {
    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, SIZE, SIZE, LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // crisp pixels up close
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
    return texture;
}

export function createLeafTextures(gl, unit, motionUnit) {
    const random = alea('leaves');
    const layers = FOLIAGES.map(foliage => makeLayer(random, foliage));
    const toBytes = key => {
        const data = new Uint8Array(SIZE * SIZE * 4 * LAYERS);
        layers.forEach((layer, l) => {
            // the palette is in sRGB, like the texture
            for (let i = 0; i < SIZE * SIZE * 4; i++) data[l * SIZE * SIZE * 4 + i] = Math.round(Math.min(1, Math.max(0, layer[key][i])) * 255);
        });
        return data;
    };
    createArray(gl, unit, toBytes('rgba'), true, true);
    createArray(gl, motionUnit, toBytes('motion'), false, false);
}
