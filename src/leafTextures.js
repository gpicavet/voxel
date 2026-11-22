import alea from 'alea';

// Minecraft-like foliage: one 16 x 16 pixel art texture per face of a leaf voxel, with transparent holes, drawn with crisp
// pixels. Layers: 0 oak, 1 birch, 2 needles, 3 bush. The holes keep a dark green (seen in the full foliage far away).

const SIZE = 16;
const LAYERS = 4;

function makeLayer(random, { clusters, coverage, light, dark, hole, clusterSize }) {
    const rgba = new Float32Array(SIZE * SIZE * 4);
    const set = (x, y, c) => {
        const i = (((y % SIZE) + SIZE) % SIZE * SIZE + ((x % SIZE) + SIZE) % SIZE) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 1;
    };
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
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
    return rgba;
}

function makeNeedles(random) {
    const dark = [0.10, 0.20, 0.13], light = [0.24, 0.40, 0.25], hole = [0.05, 0.11, 0.07];
    const rgba = new Float32Array(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) rgba.set([...hole, 0], i * 4);
    const set = (x, y, c) => {
        const i = (((y % SIZE) + SIZE) % SIZE * SIZE + ((x % SIZE) + SIZE) % SIZE) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 1;
    };
    // twigs going down diagonally, needles on both sides
    for (let t = 0; t < 7; t++) {
        let x = Math.floor(random() * SIZE), y = Math.floor(random() * SIZE);
        const dir = random() < 0.5 ? 1 : -1;
        for (let s = 0; s < 9; s++) {
            set(x, y, [0.18, 0.13, 0.08]);
            const shade = random();
            const c = [dark[0] + (light[0] - dark[0]) * shade, dark[1] + (light[1] - dark[1]) * shade, dark[2] + (light[2] - dark[2]) * shade];
            set(x - 1, y, c);
            set(x + 1, y, c);
            if (random() < 0.6) set(x - 2, y - 1, c);
            if (random() < 0.6) set(x + 2, y - 1, c);
            x += random() < 0.6 ? dir : 0;
            y -= 1;
        }
    }
    return rgba;
}

export function createLeafTextures(gl, unit) {
    const random = alea('leaves');
    const layers = [
        makeLayer(random, { clusters: 16, coverage: 0.72, light: [0.36, 0.56, 0.18], dark: [0.11, 0.24, 0.06], hole: [0.07, 0.15, 0.04], clusterSize: [1.2, 2.4] }),
        makeLayer(random, { clusters: 22, coverage: 0.66, light: [0.62, 0.74, 0.30], dark: [0.26, 0.40, 0.12], hole: [0.16, 0.25, 0.08], clusterSize: [0.8, 1.6] }),
        makeNeedles(random),
        makeLayer(random, { clusters: 18, coverage: 0.8, light: [0.30, 0.48, 0.15], dark: [0.09, 0.20, 0.05], hole: [0.06, 0.13, 0.04], clusterSize: [1.4, 2.6] }),
    ];
    const data = new Uint8Array(SIZE * SIZE * 4 * LAYERS);
    layers.forEach((layer, l) => {
        for (let i = 0; i < SIZE * SIZE * 4; i++) {
            // the palette is in sRGB, like the texture
            data[l * SIZE * SIZE * 4 + i] = Math.round(Math.min(1, Math.max(0, layer[i])) * 255);
        }
    });

    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.SRGB8_ALPHA8, SIZE, SIZE, LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // crisp pixels up close
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
    return texture;
}
