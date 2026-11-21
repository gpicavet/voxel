import { vec3 } from "gl-matrix";

const SIZE_POW = 6;
const SIZE = 1 << SIZE_POW;

// Materials, decoded in vertex.glsl
export const EARTH = 0, ROCK = 1, GRASS = 2;

// The mesher reads a copy of the chunk padded with one voxel from the neighbours on every side,
// so faces between chunks are culled and ambient occlusion is right at chunk borders.
const P = SIZE + 2;
const PP = P * P;
const STRIDES = [PP, P, 1];
const padded = new Uint8Array(P * P * P);

// Face order: +x, -x, +y, -y, +z, -z. Corners are counter-clockwise seen from outside.
const FACES = [
    { n: [1, 0, 0], c: [[1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]] },
    { n: [-1, 0, 0], c: [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]] },
    { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[1, 1, 1], [0, 1, 1], [0, 0, 1], [1, 0, 1]] },
    { n: [0, 0, -1], c: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
];

// Precomputed per face: offset of the neighbour in the padded array, and for each corner
// the packed corner position and the offsets of the 3 voxels used for ambient occlusion.
const FACE_NEIGHBOR = new Int32Array(6);
const CORNER_BITS = new Uint32Array(24);
const AO_SIDE1 = new Int32Array(24), AO_SIDE2 = new Int32Array(24), AO_CORNER = new Int32Array(24);
FACES.forEach((face, f) => {
    const axis = face.n.findIndex(v => v !== 0);
    const [u, v] = [0, 1, 2].filter(a => a !== axis);
    const nOff = face.n[0] * STRIDES[0] + face.n[1] * STRIDES[1] + face.n[2] * STRIDES[2];
    FACE_NEIGHBOR[f] = nOff;
    face.c.forEach((c, k) => {
        const du = c[u] ? 1 : -1, dv = c[v] ? 1 : -1;
        CORNER_BITS[f * 4 + k] = c[0] | (c[1] << 7) | (c[2] << 14);
        AO_SIDE1[f * 4 + k] = nOff + du * STRIDES[u];
        AO_SIDE2[f * 4 + k] = nOff + dv * STRIDES[v];
        AO_CORNER[f * 4 + k] = nOff + du * STRIDES[u] + dv * STRIDES[v];
    });
});

// One growable list of packed vertices per face direction, reused between chunks.
const buckets = FACES.map(() => ({ data: new Uint32Array(1 << 16), len: 0 }));
const aoScratch = new Uint8Array(4);

function push(bucket, v) {
    if (bucket.len === bucket.data.length) {
        const bigger = new Uint32Array(bucket.data.length * 2);
        bigger.set(bucket.data);
        bucket.data = bigger;
    }
    bucket.data[bucket.len++] = v;
}

export class Chunk {
    static SIZE_POW = SIZE_POW;//size = 64
    static SIZE = SIZE;
    static SIZE_HALF = SIZE >> 1;

    constructor(pos) {
        this.pos = pos;
        this.voxels = new Uint8Array(SIZE * SIZE * SIZE);
        this.aabbMin = vec3.clone(pos);
        this.aabbMax = vec3.fromValues(pos[0] + SIZE, pos[1] + SIZE, pos[2] + SIZE);
        this.centerPos = vec3.fromValues(pos[0] + Chunk.SIZE_HALF, pos[1] + Chunk.SIZE_HALF, pos[2] + Chunk.SIZE_HALF);
        this.vertexArray = null;
        this.vertexBuffer = null;
        this.nFaces = 0;
        // per face direction: first face and face count in the vertex buffer
        this.faceFirst = new Int32Array(6);
        this.faceCount = new Int32Array(6);
    }

    setVoxel(x, y, z, val) {
        this.voxels[(((x << SIZE_POW) + y) << SIZE_POW) + z] = val;
    }
    getVoxel(x, y, z) {
        return this.voxels[(((x << SIZE_POW) + y) << SIZE_POW) + z];
    }

    init(noise) {
        for (var x = 0; x < SIZE; x++) {
            for (var y = 0; y < SIZE; y++) {
                for (var z = 0; z < SIZE; z++) {
                    var dens = (noise((this.pos[0] + x) * 0.01,
                        (this.pos[1] + y) * 0.01,
                        (this.pos[2] + z) * 0.01));

                    this.setVoxel(x, y, z, (z + this.pos[2] == 0 || dens < -0.1) ? 1 : 0);
                }
            }
        }
    }

    intersectsSphere(center, radius) {
        var dmin = 0;
        for (var i = 0; i < 3; i++) {
            if (center[i] < this.aabbMin[i])
                dmin += (center[i] - this.aabbMin[i]) * (center[i] - this.aabbMin[i]);
            else if (center[i] > this.aabbMax[i])
                dmin += (center[i] - this.aabbMax[i]) * (center[i] - this.aabbMax[i]);
        }
        return dmin <= radius * radius;
    }

    /**
     * Remove the voxels inside the sphere. Only the voxels of the sphere bounding box are visited.
     * @returns true if a voxel changed
     */
    boom(center, radius) {
        const lo = [], hi = [], c = [];
        for (let i = 0; i < 3; i++) {
            c[i] = center[i] - this.pos[i];
            lo[i] = Math.max(0, Math.floor(c[i] - radius));
            hi[i] = Math.min(SIZE - 1, Math.ceil(c[i] + radius));
        }

        const radius2 = radius * radius;
        var changed = false;
        for (var x = lo[0]; x <= hi[0]; x++) {
            for (var y = lo[1]; y <= hi[1]; y++) {
                for (var z = lo[2]; z <= hi[2]; z++) {
                    const dx = x + 0.5 - c[0], dy = y + 0.5 - c[1], dz = z + 0.5 - c[2];
                    if (dx * dx + dy * dy + dz * dz < radius2 && this.getVoxel(x, y, z) > 0) {
                        this.setVoxel(x, y, z, 0);
                        changed = true;
                    }
                }
            }
        }
        return changed;
    }

    /**
     * Build the mesh. A vertex is a single uint32:
     * x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (2 bits)
     * Each face is 4 vertices; the triangles come from an index buffer shared by all chunks.
     * Faces are grouped by direction so that the directions facing away from the camera can be skipped.
     * @param terrain gives the voxels of the neighbour chunks (getVoxel in world coordinates)
     * @returns the packed vertices
     */
    buildMesh(terrain) {
        this.fillPadded(terrain);

        for (const b of buckets) b.len = 0;

        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) {
                let pi = (x + 1) * PP + (y + 1) * P;
                for (let z = 0; z < SIZE; z++) {
                    pi++;
                    if (padded[pi] === 0) continue;

                    let mat = EARTH;
                    if (padded[pi + 1] === 0) {
                        mat = GRASS;
                    } else if (z + this.pos[2] > 30) {
                        mat = ROCK;
                    }
                    const base = x | (y << 7) | (z << 14) | (mat << 26);

                    for (let f = 0; f < 6; f++) {
                        if (padded[pi + FACE_NEIGHBOR[f]] !== 0) continue;

                        // ambient occlusion level per corner: 0 (dark) .. 3 (no occlusion)
                        const ao = aoScratch;
                        for (let k = 0; k < 4; k++) {
                            const i = f * 4 + k;
                            const s1 = padded[pi + AO_SIDE1[i]] !== 0 ? 1 : 0;
                            const s2 = padded[pi + AO_SIDE2[i]] !== 0 ? 1 : 0;
                            const co = padded[pi + AO_CORNER[i]] !== 0 ? 1 : 0;
                            ao[k] = (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                        }

                        // the shared index buffer splits each quad along its 0-2 diagonal;
                        // rotating the corners splits it along 1-3 instead, which avoids
                        // anisotropic ambient occlusion artifacts
                        const start = (ao[0] + ao[2] < ao[1] + ao[3]) ? 1 : 0;
                        const bucket = buckets[f];
                        for (let j = 0; j < 4; j++) {
                            const k = (start + j) & 3;
                            push(bucket, (base + CORNER_BITS[f * 4 + k]) | (f << 21) | (ao[k] << 24));
                        }
                    }
                }
            }
        }

        let total = 0;
        for (const b of buckets) total += b.len;
        const vertices = new Uint32Array(total);
        let offs = 0;
        for (let f = 0; f < 6; f++) {
            vertices.set(buckets[f].data.subarray(0, buckets[f].len), offs);
            this.faceFirst[f] = offs >> 2;
            this.faceCount[f] = buckets[f].len >> 2;
            offs += buckets[f].len;
        }
        this.nFaces = total >> 2;
        return vertices;
    }

    fillPadded(terrain) {
        // interior: copy each z row
        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) {
                const src = ((x << SIZE_POW) + y) << SIZE_POW;
                padded.set(this.voxels.subarray(src, src + SIZE), (x + 1) * PP + (y + 1) * P + 1);
            }
        }
        // shell: one voxel from the neighbours
        const [ox, oy, oz] = this.pos;
        for (let x = -1; x <= SIZE; x++) {
            for (let y = -1; y <= SIZE; y++) {
                const border = x < 0 || y < 0 || x >= SIZE || y >= SIZE;
                for (let z = -1; z <= SIZE; z++) {
                    if (border || z < 0 || z >= SIZE) {
                        padded[(x + 1) * PP + (y + 1) * P + (z + 1)] = terrain.getVoxel(ox + x, oy + y, oz + z);
                    }
                }
            }
        }
    }

    upload(gl, vertices, indexBuffer) {
        if (this.vertexArray == null) {
            this.vertexArray = gl.createVertexArray();
            this.vertexBuffer = gl.createBuffer();
            gl.bindVertexArray(this.vertexArray);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
            gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
            gl.enableVertexAttribArray(0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bindVertexArray(null);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }

    /**
     * Draw the face directions that can be seen from the camera.
     * @returns the number of faces drawn
     */
    draw(gl, camPosition) {
        if (this.nFaces === 0) return 0;
        gl.bindVertexArray(this.vertexArray);
        let drawn = 0;
        for (let f = 0; f < 6; f++) {
            const count = this.faceCount[f];
            if (count === 0) continue;
            // +x faces lie on planes x in ]min, max], they can only be seen from x > min, and so on
            const axis = f >> 1;
            const visible = (f & 1) === 0
                ? camPosition[axis] > this.aabbMin[axis]
                : camPosition[axis] < this.aabbMax[axis];
            if (!visible) continue;
            gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_INT, this.faceFirst[f] * 6 * 4);
            drawn += count;
        }
        return drawn;
    }
}
