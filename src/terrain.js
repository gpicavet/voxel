import alea from 'alea';
import { vec3 } from "gl-matrix";
import { createNoise3D } from "simplex-noise";
import { Chunk } from "./chunk";
import { aabbInFrustum, frustumPlanes } from "./utils";

// Occupancy pyramid for the shadow rays: one texel is 0 when all its voxels are empty, so rays jump over
// empty 8^3 blocks (coarse) then 2^3 blocks (mid). Must match shadow.glsl.
export const COARSE_POW = 3;
export const MID_POW = 1;

export class Terrain {
    constructor(dim) {
        this.dim = dim;
        this.chunks = [];
        // texture coordinates = world coordinates + offset
        this.offset = [0, 1, 2].map(i => Chunk.SIZE * Math.floor(dim[i] / 2));
        this.size = [0, 1, 2].map(i => Chunk.SIZE * dim[i]);
        this.voxelTexture = null;
        this.midTexture = null;
        this.coarseTexture = null;
        this.indexBuffer = null;
        this.indexCapacity = 0; // in faces
        this.planes = new Float32Array(24);
        this.visible = [];
    }

    chunkAt(cx, cy, cz) {
        return this.chunks[(cx * this.dim[1] + cy) * this.dim[2] + cz];
    }

    /** voxel at world coordinates: below the world is solid, around it is empty */
    getVoxel(wx, wy, wz) {
        const tx = wx + this.offset[0], ty = wy + this.offset[1], tz = wz + this.offset[2];
        if (tz < 0) return 1;
        if (tx < 0 || ty < 0 || tx >= this.size[0] || ty >= this.size[1] || tz >= this.size[2]) return 0;
        const mask = Chunk.SIZE - 1;
        return this.chunkAt(tx >> Chunk.SIZE_POW, ty >> Chunk.SIZE_POW, tz >> Chunk.SIZE_POW)
            .getVoxel(tx & mask, ty & mask, tz & mask);
    }

    init(gl) {
        const noise3D = createNoise3D(alea('0'));

        console.log("generating chunks")

        const c = [0, 1, 2].map(i => Math.floor(this.dim[i] / 2));
        this.chunks = [];
        for (var x = 0; x < this.dim[0]; x++) {
            for (var y = 0; y < this.dim[1]; y++) {
                for (var z = 0; z < this.dim[2]; z++) {
                    const chunk = new Chunk(
                        vec3.fromValues((x - c[0]) << Chunk.SIZE_POW, (y - c[1]) << Chunk.SIZE_POW, (z - c[2]) << Chunk.SIZE_POW));
                    chunk.init(noise3D);
                    this.chunks.push(chunk);
                }
            }
        }

        // meshing needs the neighbours, so it starts once every chunk is generated
        console.log("meshing chunks")
        this.indexBuffer = gl.createBuffer();
        for (const chunk of this.chunks) {
            this.remesh(gl, chunk);
        }

        console.log("generating 3D textures")
        this.voxelTexture = createVoxelTexture(gl, gl.TEXTURE0, this.size[0], this.size[1], this.size[2]);
        this.coarseTexture = createVoxelTexture(gl, gl.TEXTURE1,
            this.size[0] >> COARSE_POW, this.size[1] >> COARSE_POW, this.size[2] >> COARSE_POW);
        this.midTexture = createVoxelTexture(gl, gl.TEXTURE2,
            this.size[0] >> MID_POW, this.size[1] >> MID_POW, this.size[2] >> MID_POW);
        this.updateTexture(this.chunks, gl);
    }

    remesh(gl, chunk) {
        const vertices = chunk.buildMesh(this);
        this.ensureIndexCapacity(gl, chunk.nFaces);
        chunk.upload(gl, vertices, this.indexBuffer);
    }

    /** grow the index buffer shared by all chunks: 2 triangles (6 indices) per face of 4 vertices */
    ensureIndexCapacity(gl, nFaces) {
        if (nFaces <= this.indexCapacity) return;
        let capacity = Math.max(1 << 14, this.indexCapacity);
        while (capacity < nFaces) capacity *= 2;

        const indices = new Uint32Array(capacity * 6);
        for (let q = 0; q < capacity; q++) {
            const v = q * 4, i = q * 6;
            indices[i] = v; indices[i + 1] = v + 1; indices[i + 2] = v + 2;
            indices[i + 3] = v + 2; indices[i + 4] = v + 3; indices[i + 5] = v;
        }
        // the buffer object is kept, so the vertex arrays already pointing at it see the new content
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        this.indexCapacity = capacity;
    }

    /** upload the voxels of the chunks into the fine, mid and coarse 3D textures */
    updateTexture(chunks, gl) {
        console.log("updating 3D texture")

        const S = Chunk.SIZE, POW = Chunk.SIZE_POW, CS = S >> COARSE_POW, MS = S >> MID_POW;
        const fine = new Uint8Array(S * S * S);
        const coarse = new Uint8Array(CS * CS * CS);
        const mid = new Uint8Array(MS * MS * MS);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        for (const chunk of chunks) {
            coarse.fill(0);
            mid.fill(0);
            let offs = 0;
            // texture layout: x varies fastest
            for (let z = 0; z < S; z++) {
                for (let y = 0; y < S; y++) {
                    for (let x = 0; x < S; x++) {
                        const v = chunk.voxels[(((x << POW) + y) << POW) + z];
                        fine[offs++] = v;
                        if (v) {
                            coarse[(((z >> COARSE_POW) * CS) + (y >> COARSE_POW)) * CS + (x >> COARSE_POW)] = 1;
                            mid[(((z >> MID_POW) * MS) + (y >> MID_POW)) * MS + (x >> MID_POW)] = 1;
                        }
                    }
                }
            }

            const tx = chunk.pos[0] + this.offset[0], ty = chunk.pos[1] + this.offset[1], tz = chunk.pos[2] + this.offset[2];

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_3D, this.voxelTexture);
            gl.texSubImage3D(gl.TEXTURE_3D, 0, tx, ty, tz, S, S, S, gl.RED_INTEGER, gl.UNSIGNED_BYTE, fine);

            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, this.coarseTexture);
            gl.texSubImage3D(gl.TEXTURE_3D, 0, tx >> COARSE_POW, ty >> COARSE_POW, tz >> COARSE_POW,
                CS, CS, CS, gl.RED_INTEGER, gl.UNSIGNED_BYTE, coarse);

            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_3D, this.midTexture);
            gl.texSubImage3D(gl.TEXTURE_3D, 0, tx >> MID_POW, ty >> MID_POW, tz >> MID_POW,
                MS, MS, MS, gl.RED_INTEGER, gl.UNSIGNED_BYTE, mid);
        }
        gl.activeTexture(gl.TEXTURE0);
    }

    /**
     * First solid voxel along the ray (voxel traversal, Amanatides & Woo).
     * @returns {{point, dist}} the point where the ray enters the voxel, or null
     */
    intersection(from, dir, maxDist = 500) {
        const cell = [Math.floor(from[0]), Math.floor(from[1]), Math.floor(from[2])];
        const step = [], tDelta = [], tMax = [];
        for (let i = 0; i < 3; i++) {
            step[i] = Math.sign(dir[i]);
            tDelta[i] = dir[i] !== 0 ? Math.abs(1 / dir[i]) : Infinity;
            tMax[i] = dir[i] > 0 ? (cell[i] + 1 - from[i]) * tDelta[i]
                : dir[i] < 0 ? (from[i] - cell[i]) * tDelta[i]
                    : Infinity;
        }

        let t = 0;
        while (t <= maxDist) {
            if (this.getVoxel(cell[0], cell[1], cell[2]) > 0) {
                return { dist: t, point: [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t] };
            }
            const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
            t = tMax[a];
            cell[a] += step[a];
            tMax[a] += tDelta[a];
        }
        return null;
    }

    boom(gl, center, radius) {
        if (!center)
            return;

        const changed = this.chunks.filter(chunk => chunk.intersectsSphere(center, radius) && chunk.boom(center, radius));
        if (changed.length === 0)
            return;

        // faces and ambient occlusion also depend on the voxels next to the removed ones
        for (const chunk of this.chunks) {
            if (chunk.intersectsSphere(center, radius + 2)) {
                this.remesh(gl, chunk);
            }
        }
        this.updateTexture(changed, gl);
    }

    /**
     * Chunks inside the camera frustum, from the nearest to the farthest
     * (front to back limits overdraw in the depth pre-pass).
     */
    cull(viewProj, camPosition) {
        frustumPlanes(this.planes, viewProj);
        const visible = this.visible;
        visible.length = 0;
        for (const chunk of this.chunks) {
            if (chunk.nFaces > 0 && aabbInFrustum(this.planes, chunk.aabbMin, chunk.aabbMax)) {
                chunk.camDist2 = vec3.sqrDist(chunk.centerPos, camPosition);
                visible.push(chunk);
            }
        }
        visible.sort((c1, c2) => c1.camDist2 - c2.camDist2);
        return visible;
    }

    /** @returns the number of faces drawn */
    draw(gl, chunks, camPosition, chunkOriginLocation) {
        let faces = 0;
        for (const chunk of chunks) {
            gl.uniform3fv(chunkOriginLocation, chunk.pos);
            faces += chunk.draw(gl, camPosition);
        }
        gl.bindVertexArray(null);
        return faces;
    }
}

function createVoxelTexture(gl, unit, w, h, d) {
    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8UI, w, h, d);
    return texture;
}
