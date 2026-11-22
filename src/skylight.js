// Sky light, as in Minecraft: 15 in the air under the open sky, minus 1 per voxel of air towards the inside
// (under overhangs, in caves). The light of a voxel only depends on the voxels within 15 of it, so a box of the
// chunks plus a margin of LIGHT_MARGIN gives the exact light of the chunks.

export const MAX_LIGHT = 15;
export const LIGHT_MARGIN = 16; // 15 + the padding voxel of the mesher

let queue = new Int32Array(1 << 16);

function grow(size) {
    const bigger = new Int32Array(Math.max(size, queue.length * 2));
    bigger.set(queue);
    queue = bigger;
}

/**
 * @param region voxels of the box, index (x * ny + y) * nz + z, 1 = solid; z = nz - 1 is the top (open sky above)
 * @param light out, same size
 */
export function computeSkylight(region, nx, ny, nz, light) {
    light.fill(0);
    const skyBottom = new Int32Array(nx * ny); // lowest voxel of the air run from the top, per column
    for (let c = 0; c < nx * ny; c++) {
        const base = c * nz;
        let z = nz - 1;
        while (z >= 0 && region[base + z] === 0) {
            light[base + z] = MAX_LIGHT;
            z--;
        }
        skyBottom[c] = z + 1;
    }

    // seeds: air next to the sky run of a neighbour column, below its own sky run (under an overhang, cave entrance)
    let tail = 0;
    const NZ = nz, NYZ = ny * nz;
    for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) {
            const c = x * ny + y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const xn = x + dx, yn = y + dy;
                if (xn < 0 || yn < 0 || xn >= nx || yn >= ny) continue;
                const n = xn * ny + yn;
                // z where c is in the sky and n is not
                for (let z = skyBottom[c]; z < skyBottom[n]; z++) {
                    const i = n * nz + z;
                    if (region[i] === 0 && light[i] < MAX_LIGHT - 1) {
                        light[i] = MAX_LIGHT - 1;
                        if (tail === queue.length) grow(tail + 1);
                        queue[tail++] = i;
                    }
                }
            }
        }
    }

    // breadth first propagation, decreasing by one per voxel
    for (let head = 0; head < tail; head++) {
        const i = queue[head];
        const l = light[i] - 1;
        if (l <= 0) continue;
        const z = i % NZ, y = ((i / NZ) | 0) % ny, x = (i / NYZ) | 0;
        // 6 neighbours, inside the box
        if (x > 0) tail = spread(i - NYZ, l, tail);
        if (x < nx - 1) tail = spread(i + NYZ, l, tail);
        if (y > 0) tail = spread(i - NZ, l, tail);
        if (y < ny - 1) tail = spread(i + NZ, l, tail);
        if (z > 0) tail = spread(i - 1, l, tail);
        if (z < nz - 1) tail = spread(i + 1, l, tail);
    }

    function spread(j, l, tail) {
        if (region[j] === 0 && light[j] < l) {
            light[j] = l;
            if (tail === queue.length) grow(tail + 1);
            queue[tail++] = j;
        }
        return tail;
    }
    return light;
}
