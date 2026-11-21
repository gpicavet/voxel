import { CHUNK_SIZE } from './constants';
import { P } from './generator';

// Cave culling (Tommaso Checchi's algorithm, as in Minecraft): for each chunk, which of its 6 faces are connected
// through air inside it. A traversal from the camera then only crosses chunks through connected faces,
// so caves are drawn only when an opening makes them visible.

const SIZE = CHUNK_SIZE;
const visited = new Uint8Array(SIZE * SIZE * SIZE);
const queue = new Int32Array(SIZE * SIZE * SIZE);

export const ALL_CONNECTED = 0x3f;

/** connectivity of a uniform chunk: all air -> every face reaches every face, all solid -> none */
export function uniformConnectivity(uniform) {
    return new Uint8Array(6).fill(uniform ? 0 : ALL_CONNECTED);
}

/**
 * Faces (+x, -x, +y, -y, +z, -z) connected through air inside the chunk.
 * @param padded voxels of the chunk, index ((x + 1) * P + (y + 1)) * P + (z + 1)
 * @returns connectivity[face] = bit mask of the faces it is connected to
 */
export function faceConnectivity(padded) {
    const connectivity = new Uint8Array(6);
    visited.fill(0);
    const last = SIZE - 1;
    for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
            const sideXY = x === 0 || y === 0 || x === last || y === last;
            // only the air on the chunk boundary matters: start a flood fill from every unvisited boundary voxel
            for (let z = 0; z < SIZE; z += (sideXY ? 1 : last)) {
                const start = (x * SIZE + y) * SIZE + z;
                if (visited[start] || padded[((x + 1) * P + (y + 1)) * P + (z + 1)]) continue;
                const faces = flood(padded, start);
                for (let f = 0; f < 6; f++) {
                    if (faces & (1 << f)) connectivity[f] |= faces;
                }
            }
        }
    }
    return connectivity;
}

// flood fill of the air component containing start; returns the faces it touches
function flood(padded, start) {
    const last = SIZE - 1;
    let head = 0, tail = 0, faces = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
        const i = queue[head++];
        const x = (i / (SIZE * SIZE)) | 0, y = ((i / SIZE) | 0) % SIZE, z = i % SIZE;
        if (x === last) faces |= 1; else visit(padded, i + SIZE * SIZE, x + 1, y, z);
        if (x === 0) faces |= 2; else visit(padded, i - SIZE * SIZE, x - 1, y, z);
        if (y === last) faces |= 4; else visit(padded, i + SIZE, x, y + 1, z);
        if (y === 0) faces |= 8; else visit(padded, i - SIZE, x, y - 1, z);
        if (z === last) faces |= 16; else visit(padded, i + 1, x, y, z + 1);
        if (z === 0) faces |= 32; else visit(padded, i - 1, x, y, z - 1);
    }
    return faces;

    function visit(padded, j, x, y, z) {
        if (visited[j] || padded[((x + 1) * P + (y + 1)) * P + (z + 1)]) return;
        visited[j] = 1;
        queue[tail++] = j;
    }
}
