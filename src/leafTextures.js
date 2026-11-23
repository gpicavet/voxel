import alea from 'alea';

// Minecraft-like foliage: one 16 x 16 pixel art texture per face of a leaf voxel, with transparent holes, drawn with crisp
// pixels. Layers: 0 oak, 1 birch, 2 needles (spruce), 3 bush. The holes keep a dark green (seen in the full foliage far away).
// A second texture gives the motion of each clump of leaves in the wind (tree_surface.glsl): per texel, the phase, the
// amplitude and the speed of the clump it belongs to.

const SIZE = 16;
const LAYERS = 4;

function makeLayer(random, { clusters, coverage, light, dark, hole, clusterSize }) {
    const rgba = new Float32Array(SIZE * SIZE * 4);
    const motion = new Float32Array(SIZE * SIZE * 4).fill(0.5);
    let clump = null; // phase, amplitude, speed of the clump being drawn
    const set = (x, y, c) => {
        const t = ((y % SIZE) + SIZE) % SIZE * SIZE + ((x % SIZE) + SIZE) % SIZE, i = t * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 1;
        motion[i] = clump[0]; motion[i + 1] = clump[1]; motion[i + 2] = clump[2]; motion[i + 3] = 1;
    };
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // holes: seen only on the full foliage of the far levels of detail, close to the shaded leaves behind them
    hole = mix(hole, dark, 0.7);
    for (let i = 0; i < SIZE * SIZE; i++) rgba.set([...hole, 0], i * 4);

    const covered = () => {
        let n = 0;
        for (let i = 0; i < SIZE * SIZE; i++) n += rgba[i * 4 + 3];
        return n / (SIZE * SIZE);
    };
    // clumps of leaves: a small blob of pixels, lit from the top left
    for (let k = 0; k < clusters * 4 && (k < clusters || covered() < coverage); k++) {
        const cx = Math.floor(random() * SIZE), cy = Math.floor(random() * SIZE);
        const r = clusterSize[0] + random() * (clusterSize[1] - clusterSize[0]);
        const base = random();
        clump = [random(), 0.5 + random() * 0.5, random()];
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
            for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
                const d = Math.abs(dx) + Math.abs(dy) * 0.9;
                if (d > r + random() * 0.6) continue;
                // highlight towards the top left (texture y is up), shadow towards the bottom right
                const shade = Math.min(1, Math.max(0, base * 0.6 + 0.2 + (dy - dx) / (2 * r + 1) * 0.5 + (random() - 0.5) * 0.25));
                set(cx + dx, cy + dy, mix(dark, light, shade));
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
    const layers = [
        makeLayer(random, { clusters: 16, coverage: 0.74, light: [0.42, 0.62, 0.20], dark: [0.13, 0.27, 0.07], hole: [0.08, 0.16, 0.05], clusterSize: [1.2, 2.4] }),
        makeLayer(random, { clusters: 22, coverage: 0.66, light: [0.62, 0.74, 0.30], dark: [0.26, 0.40, 0.12], hole: [0.16, 0.25, 0.08], clusterSize: [0.8, 1.6] }),
        // needles: small dense tufts, spruce green
        makeLayer(random, { clusters: 30, coverage: 0.84, light: [0.42, 0.58, 0.22], dark: [0.12, 0.26, 0.10], hole: [0.07, 0.15, 0.06], clusterSize: [0.7, 1.4] }),
        makeLayer(random, { clusters: 18, coverage: 0.8, light: [0.30, 0.48, 0.15], dark: [0.09, 0.20, 0.05], hole: [0.06, 0.13, 0.04], clusterSize: [1.4, 2.6] }),
    ];
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
