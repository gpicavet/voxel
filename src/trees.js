import { TREE_LODS } from './treeModels';
import { MODEL_COUNT, TREE_FLOATS } from './treePlacement';
import { aabbInFrustum } from './utils';

// Rendering of the trees: one instanced draw per species and level of detail. The instances are gathered each frame
// from the columns, into "sets" (camera, sun shadow map), each with its own instance buffers.

const INSTANCE_FLOATS = 8; // position + yaw, scale + tint + sky light + sway phase
const LOD_DISTANCES = [90, 280]; // beyond the last one: coarsest model
const BUCKETS = MODEL_COUNT * TREE_LODS;

export class TreeRenderer {
    /** @param world gives the shared index buffer (ensureIndexCapacity, indexBuffer) and the columns */
    constructor(gl, world) {
        this.gl = gl;
        this.world = world;
        this.models = null; // built in a worker: setModels
        this.crowns = null;
        // camera, reflection in the water, tree shadow maps near the camera, far tree shadow map
        const empty = () => ({ buckets: [], trees: 0, faces: 0 });
        this.sets = { camera: empty(), reflection: empty(), shadow: empty(), far: empty() };
        this.min = new Float32Array(3);
        this.max = new Float32Array(3);
    }

    /** models of treeModels.js (per model, per level of detail) */
    setModels(models) {
        const gl = this.gl, world = this.world;
        this.models = models.map(lods => lods.map(model => {
            world.ensureIndexCapacity(model.nFaces);
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, model.vertices, gl.STATIC_DRAW);
            return { ...model, buffer };
        }));
        this.crowns = this.models.map(lods => lods[0].crown);
        this.sets = { camera: this.createSet(), reflection: this.createSet(), shadow: this.createSet(), far: this.createSet() };
    }

    createSet() {
        const gl = this.gl;
        const buckets = [];
        for (let b = 0; b < BUCKETS; b++) {
            const model = this.models[Math.floor(b / TREE_LODS)][b % TREE_LODS];
            const vao = gl.createVertexArray();
            const instances = gl.createBuffer();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, model.buffer);
            gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
            gl.enableVertexAttribArray(0);
            gl.bindBuffer(gl.ARRAY_BUFFER, instances);
            gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
            gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 16);
            gl.enableVertexAttribArray(1);
            gl.enableVertexAttribArray(2);
            gl.vertexAttribDivisor(1, 1);
            gl.vertexAttribDivisor(2, 1);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.world.indexBuffer);
            gl.bindVertexArray(null);
            buckets.push({ vao, instances, data: new Float32Array(1024 * INSTANCE_FLOATS), count: 0, model, lod: b % TREE_LODS });
        }
        return { buckets, trees: 0, faces: 0 };
    }

    /**
     * Gather the trees of the meshed columns into a set: within maxDistance of the eye, inside the planes (or all of
     * them when planes is null), with the level of detail of their distance (never finer than minLod).
     */
    gather(setName, eye, planes, maxDistance, minLod = 0) {
        const gl = this.gl;
        const set = this.sets[setName];
        if (!this.models) return;
        for (const bucket of set.buckets) bucket.count = 0;
        const maxDistance2 = maxDistance * maxDistance;
        set.trees = 0;
        set.faces = 0;
        for (const column of this.world.columns.values()) {
            const trees = column.trees;
            if (!column.hasMesh || !trees || trees.ids.length === 0) continue;
            if (planes) {
                this.min.set([trees.bounds[0], trees.bounds[1], trees.bounds[2]]);
                this.max.set([trees.bounds[3], trees.bounds[4], trees.bounds[5]]);
                if (!aabbInFrustum(planes, this.min, this.max)) continue;
            }
            const d = trees.data;
            for (let i = 0; i < trees.ids.length; i++) {
                const o = i * TREE_FLOATS;
                const dx = d[o] - eye[0], dy = d[o + 1] - eye[1], dz = d[o + 2] - eye[2];
                const distance2 = dx * dx + dy * dy + dz * dz;
                if (distance2 > maxDistance2) continue;
                let lod = distance2 < LOD_DISTANCES[0] ** 2 ? 0 : distance2 < LOD_DISTANCES[1] ** 2 ? 1 : 2;
                lod = Math.max(lod, minLod);
                const bucket = set.buckets[d[o + 8] * TREE_LODS + lod];
                if ((bucket.count + 1) * INSTANCE_FLOATS > bucket.data.length) {
                    const bigger = new Float32Array(bucket.data.length * 2);
                    bigger.set(bucket.data);
                    bucket.data = bigger;
                }
                bucket.data.set(d.subarray(o, o + INSTANCE_FLOATS), bucket.count * INSTANCE_FLOATS);
                bucket.count++;
                set.trees++;
                set.faces += bucket.model.nFaces;
            }
        }
        for (const bucket of set.buckets) {
            if (bucket.count === 0) continue;
            gl.bindBuffer(gl.ARRAY_BUFFER, bucket.instances);
            gl.bufferData(gl.ARRAY_BUFFER, bucket.data.subarray(0, bucket.count * INSTANCE_FLOATS), gl.STREAM_DRAW);
        }
    }

    /** draw a set with the current program (uniforms modelOrigin and voxelSize) */
    draw(setName, locations) {
        const gl = this.gl;
        for (const bucket of this.sets[setName].buckets) {
            if (bucket.count === 0) continue;
            gl.uniform3fv(locations.modelOrigin, bucket.model.origin);
            gl.uniform1f(locations.voxelSize, bucket.model.voxelSize);
            // transparent gaps in the leaves of the finest level only (further, the foliage is full)
            if (locations.cutout) gl.uniform1i(locations.cutout, bucket.lod === 0 ? 1 : 0);
            gl.bindVertexArray(bucket.vao);
            gl.drawElementsInstanced(gl.TRIANGLES, bucket.model.nFaces * 6, gl.UNSIGNED_INT, 0, bucket.count);
        }
        gl.bindVertexArray(null);
    }
}

/** bounding box of the trees of a column (with a margin for the crowns), for the frustum culling */
export function treeBounds(data) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let o = 0; o < data.length; o += TREE_FLOATS) {
        for (let k = 0; k < 3; k++) {
            b[k] = Math.min(b[k], data[o + k]);
            b[k + 3] = Math.max(b[k + 3], data[o + k]);
        }
    }
    const margin = 22; // the widest crowns, scaled up
    return [b[0] - margin, b[1] - margin, b[2] - 1, b[3] + margin, b[4] + margin, b[5] + 35];
}
