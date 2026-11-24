import { vec3 } from "gl-matrix";
import { BEDROCK_TOP, BRICK_BYTES, CHUNK_POW, CHUNK_SIZE } from "./constants";
import { coarseFromBricks } from "./mesher";

const SIZE = CHUNK_SIZE;

function brickIndex(x, y, z) {
    return (((z >> 1) << 5 | (y >> 1)) << 5) | (x >> 1);
}
function brickBit(x, y, z) {
    return (x & 1) | ((y & 1) << 1) | ((z & 1) << 2);
}

/**
 * A 64^3 chunk: voxels at 1 bit each (or nothing when the chunk is all air or all solid), and its mesh on the GPU.
 */
export class Chunk {
    static SIZE_POW = CHUNK_POW;
    static SIZE = SIZE;

    constructor(cx, cy, cz) {
        this.cx = cx;
        this.cy = cy;
        this.cz = cz;
        this.pos = vec3.fromValues(cx * SIZE, cy * SIZE, cz * SIZE);
        this.aabbMin = vec3.clone(this.pos);
        this.aabbMax = vec3.fromValues(this.pos[0] + SIZE, this.pos[1] + SIZE, this.pos[2] + SIZE);
        this.centerPos = vec3.fromValues(this.pos[0] + SIZE / 2, this.pos[1] + SIZE / 2, this.pos[2] + SIZE / 2);

        this.uniform = 0;     // value of every voxel when bricks is null
        this.bricks = null;   // 1 byte per 2x2x2 voxels (layout of the shadow texture)
        this.coarse = null;   // 1 byte per 8x8x8 voxels, 0 when empty
        this.modified = false;
        this.connectivity = null; // per face, mask of the faces connected to it through air (cave culling)
        this.visibleFrame = -1;

        this.vertexArray = null;
        this.vertexBuffer = null;
        this.nFaces = 0;
        this.faceFirst = new Int32Array(6);
        this.faceCount = new Int32Array(6);
        this.waterVertexArray = null;
        this.waterBuffer = null;
        this.nWaterFaces = 0;
    }

    setData(uniform, bricks, coarse, connectivity) {
        this.uniform = uniform < 0 ? 0 : uniform;
        this.bricks = bricks;
        this.coarse = coarse;
        this.connectivity = connectivity;
    }

    getVoxel(x, y, z) {
        const b = this.bricks;
        if (b === null) return this.uniform;
        return (b[brickIndex(x, y, z)] >> brickBit(x, y, z)) & 1;
    }

    setVoxel(x, y, z, val) {
        if (this.bricks === null) {
            if (val === this.uniform) return;
            this.bricks = new Uint8Array(BRICK_BYTES).fill(this.uniform ? 0xff : 0);
        }
        const i = brickIndex(x, y, z), bit = 1 << brickBit(x, y, z);
        this.bricks[i] = val ? (this.bricks[i] | bit) : (this.bricks[i] & ~bit);
        this.modified = true;
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
        lo[2] = Math.max(lo[2], BEDROCK_TOP - this.pos[2]); // bedrock is indestructible

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
        if (changed) {
            this.coarse = coarseFromBricks(this.bricks);
        }
        return changed;
    }

    upload(gl, mesh, indexBuffer) {
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
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
        this.faceFirst.set(mesh.faceFirst);
        this.faceCount.set(mesh.faceCount);
        this.nFaces = mesh.nFaces;
    }

    /** water mesh (or null), drawn in its own transparent pass */
    uploadWater(gl, mesh, indexBuffer) {
        if (!mesh) {
            this.nWaterFaces = 0;
            return;
        }
        if (this.waterVertexArray == null) {
            this.waterVertexArray = gl.createVertexArray();
            this.waterBuffer = gl.createBuffer();
            gl.bindVertexArray(this.waterVertexArray);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
            gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
            gl.enableVertexAttribArray(0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bindVertexArray(null);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
        this.nWaterFaces = mesh.nFaces;
        // bounds of the water faces, in world coordinates (the part of the screen the reflection must cover)
        this.waterMin = vec3.fromValues(this.pos[0] + mesh.min[0], this.pos[1] + mesh.min[1], this.pos[2] + mesh.min[2]);
        this.waterMax = vec3.fromValues(this.pos[0] + mesh.max[0], this.pos[1] + mesh.max[1], this.pos[2] + mesh.max[2]);
    }

    drawWater(gl) {
        if (this.nWaterFaces === 0) return;
        gl.bindVertexArray(this.waterVertexArray);
        gl.drawElements(gl.TRIANGLES, this.nWaterFaces * 6, gl.UNSIGNED_INT, 0);
    }

    freeMesh(gl) {
        if (this.waterVertexArray !== null) {
            gl.deleteVertexArray(this.waterVertexArray);
            gl.deleteBuffer(this.waterBuffer);
            this.waterVertexArray = null;
            this.waterBuffer = null;
        }
        this.nWaterFaces = 0;
        if (this.vertexArray !== null) {
            gl.deleteVertexArray(this.vertexArray);
            gl.deleteBuffer(this.vertexBuffer);
            this.vertexArray = null;
            this.vertexBuffer = null;
        }
        this.nFaces = 0;
    }

    /**
     * Draw the face directions that can be seen from the camera, in one call with WEBGL_multi_draw.
     * @returns the number of faces drawn
     */
    draw(gl, camPosition, multiDraw) {
        if (this.nFaces === 0) return 0;
        gl.bindVertexArray(this.vertexArray);
        let drawn = 0, n = 0;
        for (let f = 0; f < 6; f++) {
            const count = this.faceCount[f];
            if (count === 0) continue;
            // +x faces lie on planes x in ]min, max], they can only be seen from x > min, and so on
            const axis = f >> 1;
            const visible = (f & 1) === 0
                ? camPosition[axis] > this.aabbMin[axis]
                : camPosition[axis] < this.aabbMax[axis];
            if (!visible) continue;
            drawCounts[n] = count * 6;
            drawOffsets[n] = this.faceFirst[f] * 6 * 4;
            n++;
            drawn += count;
        }
        if (multiDraw) {
            if (n > 0) multiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, drawCounts, 0, gl.UNSIGNED_INT, drawOffsets, 0, n);
        } else {
            for (let i = 0; i < n; i++) gl.drawElements(gl.TRIANGLES, drawCounts[i], gl.UNSIGNED_INT, drawOffsets[i]);
        }
        return drawn;
    }
}

const drawCounts = new Int32Array(6);
const drawOffsets = new Int32Array(6);
