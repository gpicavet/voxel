import alea from 'alea';

// Procedural pixel-art textures of the voxels, 16 x 16, generated at startup (no image file).
// Texture array layers, chosen in fragment.glsl from the material and the face:
//   0 earth, 1 rock, 2 grass top, 3 grass side (earth with a grass fringe), 4 snow top, 5 snow side
// Row 0 is the bottom of a face (texture t = 0), row 15 the top.

const SIZE = 16;

function clamp255(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function makeLayer() {
    return new Float32Array(SIZE * SIZE * 3);
}

function set(layer, x, y, rgb, k = 1) {
    const i = (y * SIZE + x) * 3;
    layer[i] = rgb[0] * k;
    layer[i + 1] = rgb[1] * k;
    layer[i + 2] = rgb[2] * k;
}

function scale(layer, x, y, k) {
    const i = (y * SIZE + x) * 3;
    layer[i] *= k;
    layer[i + 1] *= k;
    layer[i + 2] *= k;
}

// blotches: random values smoothed over their neighbours, wrapping around (tiles without seams)
function blotches(random, passes) {
    let v = Array.from({ length: SIZE * SIZE }, () => random());
    for (let p = 0; p < passes; p++) {
        const next = new Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                let sum = 0;
                for (let dy = -1; dy <= 1; dy++)
                    for (let dx = -1; dx <= 1; dx++)
                        sum += v[((y + dy + SIZE) % SIZE) * SIZE + (x + dx + SIZE) % SIZE];
                next[y * SIZE + x] = sum / 9;
            }
        }
        v = next;
    }
    // stretch to 0..1
    const lo = Math.min(...v), hi = Math.max(...v);
    return v.map(a => (a - lo) / (hi - lo));
}

const EARTH = [133, 102, 72];
const ROCK = [122, 122, 128];
const GRASS = [77, 158, 46];
const SNOW = [236, 241, 248];

function earth(random) {
    const layer = makeLayer();
    const b = blotches(random, 1);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            set(layer, x, y, EARTH, 0.8 + 0.2 * b[y * SIZE + x] + 0.12 * random());
            const r = random();
            if (r < 0.05) set(layer, x, y, [150, 140, 128], 0.9 + 0.2 * random()); // pebble
            else if (r < 0.12) scale(layer, x, y, 0.75);                          // darker clod
        }
    }
    return layer;
}

function rock(random) {
    const layer = makeLayer();
    const b = blotches(random, 2);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            set(layer, x, y, ROCK, 0.72 + 0.4 * b[y * SIZE + x] + 0.08 * random());
        }
    }
    // cracks: short random walks, darker
    for (let c = 0; c < 3; c++) {
        let x = Math.floor(random() * SIZE), y = Math.floor(random() * SIZE);
        const steps = 5 + Math.floor(random() * 5);
        for (let s = 0; s < steps; s++) {
            scale(layer, x, y, 0.62);
            x = (x + (random() < 0.5 ? 1 : random() < 0.5 ? 0 : -1) + SIZE) % SIZE;
            y = (y + (random() < 0.6 ? 1 : -1) + SIZE) % SIZE;
        }
    }
    return layer;
}

function grassTop(random) {
    const layer = makeLayer();
    const b = blotches(random, 1);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const k = 0.78 + 0.2 * b[y * SIZE + x] + 0.18 * random();
            set(layer, x, y, random() < 0.1 ? [104, 172, 52] : GRASS, k); // a few lighter blades
        }
    }
    return layer;
}

// a face of the base layer with a fringe of the top layer hanging from the top, irregular
function fringed(random, base, top, minRows, maxRows) {
    const layer = base.slice();
    for (let x = 0; x < SIZE; x++) {
        const rows = minRows + Math.floor(random() * (maxRows - minRows + 1));
        for (let r = 0; r < rows; r++) {
            const y = SIZE - 1 - r;
            for (let c = 0; c < 3; c++) layer[(y * SIZE + x) * 3 + c] = top[(y * SIZE + x) * 3 + c];
        }
        // the edge of the fringe is a bit darker (shade under the overhang)
        const edge = SIZE - 1 - rows;
        if (edge >= 0) scale(layer, x, edge, 0.85);
    }
    return layer;
}

function snowTop(random) {
    const layer = makeLayer();
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            set(layer, x, y, random() < 0.03 ? [255, 255, 255] : SNOW, 0.93 + 0.07 * random());
        }
    }
    return layer;
}

export function createVoxelTextures(gl, unit) {
    const random = alea('textures');
    const earthLayer = earth(random);
    const rockLayer = rock(random);
    const grassLayer = grassTop(random);
    const snowLayer = snowTop(random);
    const layers = [
        earthLayer,
        rockLayer,
        grassLayer,
        fringed(random, earthLayer, grassLayer, 2, 4),
        snowLayer,
        fringed(random, rockLayer, snowLayer, 3, 5),
    ];

    const data = new Uint8Array(SIZE * SIZE * 4 * layers.length);
    layers.forEach((layer, l) => {
        for (let i = 0; i < SIZE * SIZE; i++) {
            const o = (l * SIZE * SIZE + i) * 4;
            data[o] = clamp255(layer[i * 3]);
            data[o + 1] = clamp255(layer[i * 3 + 1]);
            data[o + 2] = clamp255(layer[i * 3 + 2]);
            data[o + 3] = 255;
        }
    });

    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    // sRGB: the shader reads linear colors; crisp texels up close, filtered (mipmaps) far away
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.SRGB8_ALPHA8, SIZE, SIZE, layers.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // terrain is often seen at grazing angles
    const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
    if (anisotropic) {
        const max = gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
    gl.activeTexture(gl.TEXTURE0);
    return texture;
}
