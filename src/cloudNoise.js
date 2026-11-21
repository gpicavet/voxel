import alea from 'alea';

// Tiling 3D noise for the volumetric clouds (the Perlin-Worley approach of Horizon Zero Dawn):
//   r: Perlin-Worley, billowy base shape
//   g, b, a: Worley fbm at increasing frequencies, used to erode the shape (g + b + a) and for the details
// Every component wraps around, so the texture repeats without seams.

const SIZE = 64;

function makeWorley(cells, random) {
    const points = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < points.length; i++) points[i] = random();
    // inverted distance to the nearest feature point (1 on the points), wrapping around
    return (x, y, z) => {
        const px = x * cells, py = y * cells, pz = z * cells;
        const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
        let best = 1e9;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx, ny = cy + dy, nz = cz + dz;
                    const wx = ((nx % cells) + cells) % cells, wy = ((ny % cells) + cells) % cells, wz = ((nz % cells) + cells) % cells;
                    const i = ((wz * cells + wy) * cells + wx) * 3;
                    const ox = nx + points[i] - px, oy = ny + points[i + 1] - py, oz = nz + points[i + 2] - pz;
                    best = Math.min(best, ox * ox + oy * oy + oz * oz);
                }
            }
        }
        return 1 - Math.min(1, Math.sqrt(best));
    };
}

function makePerlin(period, random) {
    const gradients = new Float32Array(period * period * period * 3);
    for (let i = 0; i < period * period * period; i++) {
        const theta = random() * 2 * Math.PI, z = random() * 2 - 1, r = Math.sqrt(1 - z * z);
        gradients.set([r * Math.cos(theta), r * Math.sin(theta), z], i * 3);
    }
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const corner = (ix, iy, iz, fx, fy, fz) => {
        const i = (((iz % period) * period + (iy % period)) * period + (ix % period)) * 3;
        return gradients[i] * fx + gradients[i + 1] * fy + gradients[i + 2] * fz;
    };
    return (x, y, z) => {
        const px = x * period, py = y * period, pz = z * period;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = px - ix, fy = py - iy, fz = pz - iz;
        const u = fade(fx), v = fade(fy), w = fade(fz);
        const lerp = (a, b, t) => a + (b - a) * t;
        return lerp(
            lerp(lerp(corner(ix, iy, iz, fx, fy, fz), corner(ix + 1, iy, iz, fx - 1, fy, fz), u),
                lerp(corner(ix, iy + 1, iz, fx, fy - 1, fz), corner(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u), v),
            lerp(lerp(corner(ix, iy, iz + 1, fx, fy, fz - 1), corner(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u),
                lerp(corner(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), corner(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u), v), w);
    };
}

export function createCloudNoiseTexture(gl, unit) {
    const random = alea('clouds');
    const worley = [4, 8, 16, 32].map(cells => makeWorley(cells, random));
    const perlin = [4, 8, 16].map(period => makePerlin(period, random));

    const data = new Uint8Array(SIZE * SIZE * SIZE * 4);
    let o = 0;
    for (let z = 0; z < SIZE; z++) {
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE, w = (z + 0.5) / SIZE;
                const w4 = worley[0](u, v, w), w8 = worley[1](u, v, w), w16 = worley[2](u, v, w), w32 = worley[3](u, v, w);
                const perlinFbm = Math.min(1, Math.max(0, 0.5 + (perlin[0](u, v, w) + 0.5 * perlin[1](u, v, w) + 0.25 * perlin[2](u, v, w)) / 1.75 * 0.9));
                const worleyFbm = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
                // Perlin-Worley: Perlin shapes with Worley billows
                const perlinWorley = worleyFbm + perlinFbm * (1 - worleyFbm) * 0.9 - 0.25 * (1 - perlinFbm);
                data[o++] = Math.round(255 * Math.min(1, Math.max(0, perlinWorley)));
                data[o++] = Math.round(255 * worleyFbm);
                data[o++] = Math.round(255 * (w8 * 0.625 + w16 * 0.25 + w32 * 0.125));
                data[o++] = Math.round(255 * (w16 * 0.75 + w32 * 0.25));
            }
        }
    }

    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
        gl.texParameteri(gl.TEXTURE_3D, wrap, gl.REPEAT);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, SIZE, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.activeTexture(gl.TEXTURE0);
    return texture;
}
