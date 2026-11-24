import { mat4, vec3 } from "gl-matrix";
import { Chunk } from "./chunk";
import { runColumnTask, runHeightGridTask } from "./columnTask";
import { buildTreeModels } from "./treeModels";
import {
    BRICK_BYTES, BRICKS, CHUNK_SIZE, CHUNKS_PER_COLUMN, COARSE, COARSE_BYTES, columnKey, CZ_MAX, CZ_MIN,
    insideWorld, SEA_LEVEL, SEED, WORLD_BOTTOM, WORLD_TOP,
} from "./constants";
import { createGenerator, P } from "./generator";
import { buildMesh, buildWaterMesh } from "./mesher";
import { faceConnectivity } from "./visibility";
import { LIGHT_MARGIN } from "./skylight";
import { TREE_FLOATS } from "./treePlacement";
import { treeBounds } from "./trees";
import { aabbInFrustum, frustumPlanes } from "./utils";
import workerSource from "../build/worker.js?raw";

// Shadow window: the voxels of WINDOW x WINDOW columns around the camera are kept in the shadow textures,
// which wrap around (a column always goes to the slot (cx mod WINDOW, cy mod WINDOW)).
export const WINDOW = 16; // columns: 1024 voxels
const HALF_WINDOW = WINDOW / 2;
const WINDOW_HEIGHT = CHUNKS_PER_COLUMN * CHUNK_SIZE;
// View distance, in columns (+/- keys): columns are meshed within this radius, also beyond the shadow window (their
// shadow rays go on against the horizon height map at once, no ray traced ambient occlusion: far in the fog).
const VIEW_RADIUS = 9;      // fog at 544 voxels (main.js)
const MAX_VIEW_RADIUS = 12;

const ZERO_BRICKS = new Uint8Array(BRICK_BYTES);
const FULL_BRICKS = new Uint8Array(BRICK_BYTES).fill(0xff);
const ZERO_COARSE = new Uint8Array(COARSE_BYTES);
const FULL_COARSE = new Uint8Array(COARSE_BYTES).fill(1);

const RESULT_BUDGET_MS = 6;  // per frame, for uploading generated columns
// Chunks farther than this (horizontally, from the eye to the nearest point of the chunk) are drawn with their coarse
// mesh (voxels twice as large, a few times fewer faces); back to the real voxels a little closer (no flickering at the
// limit).
const FAR_DISTANCE = 384, FAR_HYSTERESIS = 16;
// in the reflection of the water (half resolution, blurred by the waves), much closer
const REFLECTION_FAR_DISTANCE = 192;
// Occlusion culling: in the depth pre-pass, right before each chunk is drawn (nearest first), its box is tested against the
// depth of the chunks drawn so far (hardware query, nothing written). A chunk whose box shows no sample is skipped by the
// following frames, until a new test finds it visible. WebGL gives the answers a frame or more later: a chunk uncovered by
// the movement shows up that much late. The boxes are grown by OCCLUSION_MARGIN voxels plus OCCLUSION_PIXELS pixels of the
// pre-pass (half resolution: a gap thinner than its pixels must not hide what is behind).
const OCCLUSION_MARGIN = 1, OCCLUSION_PIXELS = 1.5;
const OCCLUSION_NEAR = 4;    // eye closer than this to the box: drawn without test (the near plane would cut the box)
// A test only saw the part of the box that was in the view: after the camera turned or moved, a chunk stays hidden only
// if all of its box now in the view was in the view of the test, give or take a sliver this thin (radians).
const OCCLUSION_SLIVER = 0.0004;

/** Generation and meshing in web workers; on the main thread, one column per frame, if workers are not available. */
class WorkerPool {
    constructor(onResult, onHeightGrid) {
        this.onResult = onResult;
        this.onHeightGrid = onHeightGrid;
        this.workers = [];
        this.inFlight = [];
        try {
            const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
            const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
            for (let i = 0; i < count; i++) {
                const worker = new Worker(url);
                worker.onmessage = (event) => {
                    if (event.data.type === 'treeModels') {
                        this.onTreeModels(event.data.models);
                        return;
                    }
                    if (event.data.type === 'heightGrid') {
                        this.onHeightGrid(event.data);
                        return;
                    }
                    this.inFlight[i]--;
                    this.onResult(event.data);
                };
                worker.onerror = (event) => console.error("worker error", event.message);
                this.workers.push(worker);
                this.inFlight.push(0);
            }
        } catch (e) {
            console.warn("web workers unavailable, chunks are generated on the main thread", e);
        }
        this.mainThreadBusy = false;
    }

    newFrame() {
        this.mainThreadBusy = false;
    }

    /** tree models (treeModels.js): built once, on the first worker (or on the main thread) */
    buildTreeModels(callback) {
        this.onTreeModels = callback;
        if (this.workers.length === 0) {
            callback(buildTreeModels());
        } else {
            this.workers[0].postMessage({ type: 'treeModels' });
        }
    }

    /** height map of a large area: on the last worker (or on the main thread) */
    postHeightGrid(task) {
        if (this.workers.length === 0) {
            this.onHeightGrid(runHeightGridTask(task).result);
        } else {
            this.workers[this.workers.length - 1].postMessage({ type: 'heightGrid', ...task });
        }
    }

    /** @returns false when every worker already has enough work */
    post(task) {
        if (this.workers.length === 0) {
            if (this.mainThreadBusy) return false;
            this.mainThreadBusy = true;
            this.onResult(runColumnTask(task).result);
            return true;
        }
        let best = -1;
        for (let i = 0; i < this.workers.length; i++) {
            if (this.inFlight[i] < 2 && (best < 0 || this.inFlight[i] < this.inFlight[best])) best = i;
        }
        if (best < 0) return false;
        this.inFlight[best]++;
        this.workers[best].postMessage(task);
        return true;
    }

    get pending() {
        return this.inFlight.reduce((a, b) => a + b, 0);
    }
}

/**
 * The world: columns of chunks loaded around the camera, generated by the workers.
 * - every column of the shadow window keeps its voxels (1 bit per voxel), for the shadow rays
 * - columns within the view radius also have meshes
 * - modified chunks are kept when their column is unloaded, and used again when it comes back
 */
export class World {
    constructor(gl) {
        this.gl = gl;
        this.generator = createGenerator(SEED);
        this.columns = new Map();
        this.edits = new Map();        // column key -> modified chunks of an unloaded column
        this.treeRemovals = new Map(); // column key -> ids of the trees destroyed by explosions (kept when unloaded)
        this.viewRadius = VIEW_RADIUS;
        this.camColumn = null;
        this.queue = [];               // column requests, nearest last
        this.results = [];
        this.nextRequestId = 1;
        this.planes = new Float32Array(24);
        this.visible = [];
        this.frame = 0;
        this.visitedFrame = new Map(); // chunk key -> last frame the visibility traversal reached it
        this.visibilityQueue = [];
        this.caveCulling = true;
        this.occlusionCulling = true;
        this.occlusionQueries = [];    // free query objects
        this.pendingOcclusion = [];    // tests waiting for their answer: { query, chunk, epoch }
        this.cullFrame = 0;
        this.viewPlanes = new Float32Array(24); // frustum planes, unit normals (distances in voxels)
        this.viewEdges = new Float32Array(24);  // the 4 side edges of the frustum: near corner, then near to far corner
        this.invViewProj = mat4.create();
        this.occluded = 0;             // chunks of the view skipped this frame
        this.boxArray = createBoxArray(gl);
        this.padded = new Uint8Array(P * P * P);

        this.multiDraw = gl.getExtension("WEBGL_multi_draw");
        this.indexBuffer = gl.createBuffer();
        this.indexCapacity = 0;
        this.pool = new WorkerPool(result => this.results.push(result), grid => this.applyHeightGrid(grid));

        // horizon: surface heights of the generated terrain every HORIZON_STEP voxels over HORIZON_SIZE x HORIZON_STEP
        // around the camera (texture unit 2). The shadow rays that leave the loaded window go on against it, instead of
        // counting as lit: with a low sun, the distant mountains cast their shadows.
        this.horizonTexture = createHeightTexture(gl, gl.TEXTURE2, HORIZON_SIZE);
        this.horizonOrigin = new Float32Array(2);
        this.horizonValid = false;
        this.horizonCenter = null;
        this.horizonRequest = 0;
        this.horizonPending = false;

        // shadow textures: unit 0 bricks (1 bit per voxel), unit 1 coarse occupancy
        this.brickTexture = createVoxelTexture(gl, gl.TEXTURE0, WINDOW * BRICKS, WINDOW * BRICKS, CHUNKS_PER_COLUMN * BRICKS);
        this.coarseTexture = createVoxelTexture(gl, gl.TEXTURE1, WINDOW * COARSE, WINDOW * COARSE, CHUNKS_PER_COLUMN * COARSE);
        this.slotOwner = new Int32Array(WINDOW * WINDOW).fill(-1); // column key in each slot, -1 = empty
        this.windowColumn = [0, 0];                                 // column at the window corner
        this.windowMin = vec3.create();
        this.windowSize = vec3.fromValues(WINDOW * CHUNK_SIZE, WINDOW * CHUNK_SIZE, WINDOW_HEIGHT);
        this.brickOrigin = new Int32Array(3);
        this.coarseOrigin = new Int32Array(3);
    }

    setViewRadius(radius) {
        this.viewRadius = Math.max(2, Math.min(MAX_VIEW_RADIUS, radius));
        this.camColumn = null; // plan again
    }

    // ---------------------------------------------------------------- voxels

    /** voxel at world coordinates: from the loaded chunk, the modified chunk of an unloaded column, or the generator */
    getVoxel(x, y, z) {
        if (z < WORLD_BOTTOM) return 1;
        if (z >= WORLD_TOP) return 0;
        const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
        const chunk = this.chunkAt(cx, cy, cz);
        if (chunk) return chunk.getVoxel(x - cx * CHUNK_SIZE, y - cy * CHUNK_SIZE, z - cz * CHUNK_SIZE);
        if (!insideWorld(cx, cy)) return 0;
        return this.generator.solidAt(x, y, z);
    }

    chunkAt(cx, cy, cz) {
        if (cz < CZ_MIN || cz > CZ_MAX || !insideWorld(cx, cy)) return null;
        const key = columnKey(cx, cy);
        const column = this.columns.get(key);
        if (column && column.chunks) return column.chunks[cz - CZ_MIN];
        const edited = this.edits.get(key);
        return edited ? edited[cz - CZ_MIN] : null;
    }

    surfaceHeight(x, y) {
        return this.generator.surfaceHeight(x, y);
    }

    /**
     * Is the voxel water? Approximation of buildWaterMesh for the camera: in a lake column, air with only air above it up
     * to the sea level (a dug pocket on the shore, filled by the mesher, does not count).
     */
    isWater(x, y, z) {
        if (z >= SEA_LEVEL || this.surfaceHeight(x, y) >= SEA_LEVEL) return false;
        for (let k = z; k < SEA_LEVEL; k++) {
            if (this.getVoxel(x, y, k) !== 0) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- streaming

    /** load, mesh and unload columns around the camera; call once per frame */
    update(camPosition) {
        const gl = this.gl;
        const cx = Math.floor(camPosition[0] / CHUNK_SIZE), cy = Math.floor(camPosition[1] / CHUNK_SIZE);
        if (!this.camColumn || this.camColumn[0] !== cx || this.camColumn[1] !== cy) {
            this.camColumn = [cx, cy];
            this.plan();
            this.moveWindow();
        }
        this.updateHorizon(camPosition);

        this.pool.newFrame();
        while (this.queue.length > 0) {
            const request = this.queue[this.queue.length - 1];
            const key = columnKey(request.cx, request.cy);
            let column = this.columns.get(key);
            // already requested (applyResult asks again if needed), or nothing left to do
            if (column && (column.pending || (column.chunks && !request.mesh) || (column.hasMesh && !column.needsRemesh))) {
                this.queue.pop();
                continue;
            }
            const id = this.nextRequestId++;
            const version = column ? column.editVersion : 0;
            const edits = request.mesh ? this.collectEdits(request.cx, request.cy) : [];
            if (!this.pool.post({ id, cx: request.cx, cy: request.cy, mesh: request.mesh, edits, version })) break;
            this.queue.pop();
            if (!column) {
                column = { key, cx: request.cx, cy: request.cy, chunks: null, heights: null, hasMesh: false, editVersion: 0, needsRemesh: false };
                this.columns.set(key, column);
            }
            column.pending = true;
            column.requestId = id;
            if (request.mesh) column.needsRemesh = false;
        }

        const resultDeadline = performance.now() + RESULT_BUDGET_MS;
        while (this.results.length > 0 && performance.now() < resultDeadline) {
            this.applyResult(this.results.shift());
        }
    }

    plan() {
        const gl = this.gl;
        const [ccx, ccy] = this.camColumn;
        const radius = this.viewRadius;

        // kept: the shadow window and the meshed columns, with a margin (no reload when the camera goes back and forth)
        for (const column of this.columns.values()) {
            const inWindow = Math.abs(column.cx - ccx + 0.5) <= HALF_WINDOW + 1 && Math.abs(column.cy - ccy + 0.5) <= HALF_WINDOW + 1;
            const meshed = Math.hypot(column.cx - ccx, column.cy - ccy) <= radius + 1.5;
            if (!inWindow && !meshed) {
                this.unloadColumn(column);
            } else if (column.hasMesh && !meshed) {
                for (const chunk of column.chunks) chunk.freeMesh(gl);
                column.hasMesh = false;
            }
        }

        // loaded: the voxels of the shadow window (shadows only, beyond the view distance), and the meshed columns
        this.queue = [];
        const reach = Math.max(HALF_WINDOW, Math.ceil(radius));
        for (let cx = ccx - reach; cx <= ccx + reach; cx++) {
            for (let cy = ccy - reach; cy <= ccy + reach; cy++) {
                if (!insideWorld(cx, cy)) continue;
                const distance = Math.hypot(cx - ccx, cy - ccy);
                const mesh = distance <= radius;
                const inWindow = cx >= ccx - HALF_WINDOW && cx < ccx + HALF_WINDOW && cy >= ccy - HALF_WINDOW && cy < ccy + HALF_WINDOW;
                if (!mesh && !inWindow) continue;
                const column = this.columns.get(columnKey(cx, cy));
                if (!column) {
                    this.queue.push({ cx, cy, distance, mesh });
                } else if (mesh && (!column.hasMesh || column.needsRemesh) && !column.pending) {
                    this.queue.push({ cx, cy, distance, mesh });
                }
            }
        }
        // nearest at the end of the queue; meshes before voxel-only columns at the same distance
        this.queue.sort((a, b) => (b.distance + (b.mesh ? 0 : 0.5)) - (a.distance + (a.mesh ? 0 : 0.5)));
    }

    applyResult(result) {
        const gl = this.gl;
        const column = this.columns.get(columnKey(result.cx, result.cy));
        if (!column || column.requestId !== result.id) return; // unloaded or requested again meanwhile
        column.pending = false;

        if (!column.chunks) {
            column.heights = result.heights;
            const edited = this.edits.get(column.key);
            this.edits.delete(column.key);
            column.chunks = result.chunks.map((data, i) => {
                if (edited && edited[i]) return edited[i];
                const chunk = new Chunk(column.cx, column.cy, data.cz);
                chunk.setData(data.uniform, data.bricks, data.coarse, data.connectivity);
                return chunk;
            });
            this.uploadToWindow(column);
        }

        if (!result.mesh) {
            // requested for the shadows only, but the camera came closer meanwhile
            const [ccx, ccy] = this.camColumn;
            if (Math.hypot(column.cx - ccx, column.cy - ccy) <= this.viewRadius) {
                this.queue.push({ cx: column.cx, cy: column.cy, distance: 0, mesh: true });
            }
        } else if (result.version === column.editVersion) {
            // meshed by the worker with the modified chunks around: lit, and up to date
            column.hasMesh = true;
            this.setTrees(column, result.trees.data, result.trees.ids);
            result.chunks.forEach((data, i) => {
                const chunk = column.chunks[i];
                if (data.mesh) {
                    this.ensureIndexCapacity(Math.max(data.mesh.nFaces, data.coarseMesh.nFaces));
                    chunk.upload(gl, data.mesh, this.indexBuffer);
                    chunk.uploadCoarse(gl, data.coarseMesh, this.indexBuffer);
                } else {
                    chunk.freeMesh(gl);
                }
                if (data.waterMesh) this.ensureIndexCapacity(data.waterMesh.nFaces);
                chunk.uploadWater(gl, data.waterMesh, this.indexBuffer);
            });
        }
        // modified again meanwhile: mesh once more
        if (column.needsRemesh) {
            this.queue.push({ cx: column.cx, cy: column.cy, distance: 0, mesh: true });
        }
    }

    /** trees of a column, without the ones destroyed by explosions */
    setTrees(column, data, ids) {
        const removed = this.treeRemovals.get(column.key);
        if (removed) {
            const keep = [];
            for (let i = 0; i < ids.length; i++) if (!removed.has(ids[i])) keep.push(i);
            const kept = new Float32Array(keep.length * TREE_FLOATS);
            keep.forEach((i, k) => kept.set(data.subarray(i * TREE_FLOATS, (i + 1) * TREE_FLOATS), k * TREE_FLOATS));
            data = kept;
            ids = Int32Array.from(keep, i => ids[i]);
        }
        column.trees = { data, ids, bounds: treeBounds(data) };
        column.treeOcclusion = null; // new trees: unknown (trees.js)
        this.treesVersion = (this.treesVersion || 0) + 1; // the shadow map of the trees is rendered again
    }

    /** destroy the trees whose trunk is within the explosion */
    removeTrees(center, radius) {
        const reach = radius + 8;
        for (let cx = Math.floor((center[0] - reach) / CHUNK_SIZE); cx <= Math.floor((center[0] + reach) / CHUNK_SIZE); cx++) {
            for (let cy = Math.floor((center[1] - reach) / CHUNK_SIZE); cy <= Math.floor((center[1] + reach) / CHUNK_SIZE); cy++) {
                if (!insideWorld(cx, cy)) continue;
                const column = this.columns.get(columnKey(cx, cy));
                if (!column || !column.trees) continue;
                const { data, ids } = column.trees;
                let removed = this.treeRemovals.get(column.key);
                let any = false;
                for (let i = 0; i < ids.length; i++) {
                    const o = i * TREE_FLOATS;
                    // distance to the lower trunk (5 voxels)
                    const dz = center[2] - Math.min(Math.max(center[2], data[o + 2]), data[o + 2] + 5);
                    if (Math.hypot(center[0] - data[o], center[1] - data[o + 1], dz) < radius + 1) {
                        if (!removed) this.treeRemovals.set(column.key, removed = new Set());
                        removed.add(ids[i]);
                        any = true;
                    }
                }
                if (any) this.setTrees(column, data, ids);
            }
        }
    }

    /** modified chunks of the column and of the 8 around, for the workers (they change its faces and its light) */
    collectEdits(cx, cy) {
        const edits = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!insideWorld(cx + dx, cy + dy)) continue;
                const key = columnKey(cx + dx, cy + dy);
                const column = this.columns.get(key);
                const chunks = column && column.chunks ? column.chunks : this.edits.get(key);
                if (!chunks) continue;
                for (const chunk of chunks) {
                    if (chunk && chunk.modified) {
                        edits.push({ cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, uniform: chunk.uniform, bricks: chunk.bricks });
                    }
                }
            }
        }
        return edits;
    }

    unloadColumn(column) {
        const gl = this.gl;
        if (column.chunks) {
            for (const chunk of column.chunks) {
                chunk.freeMesh(gl);
            }
            if (column.chunks.some(chunk => chunk.modified)) {
                this.edits.set(column.key, column.chunks.map(chunk => chunk.modified ? chunk : null));
            }
        }
        this.columns.delete(column.key);
    }

    /**
     * Mesh a chunk on the main thread, from the real voxels of the chunk and of its neighbours: right after an
     * explosion, so the crater shows at once. Without the sky light (open sky everywhere): the workers send the lit
     * mesh a moment later.
     */
    remesh(chunk) {
        const column = this.columns.get(columnKey(chunk.cx, chunk.cy));
        if (!column || !column.chunks || !column.hasMesh) return;
        const padded = this.padded;
        const [ox, oy, oz] = chunk.pos;
        for (let x = -1; x <= CHUNK_SIZE; x++) {
            for (let y = -1; y <= CHUNK_SIZE; y++) {
                const inside = x >= 0 && y >= 0 && x < CHUNK_SIZE && y < CHUNK_SIZE;
                let pi = ((x + 1) * P + (y + 1)) * P;
                for (let z = -1; z <= CHUNK_SIZE; z++, pi++) {
                    padded[pi] = inside && z >= 0 && z < CHUNK_SIZE
                        ? chunk.getVoxel(x, y, z)
                        : this.getVoxel(ox + x, oy + y, oz + z);
                }
            }
        }
        const mesh = buildMesh(padded, column.heights, chunk.pos);
        chunk.connectivity = faceConnectivity(padded); // the voxels changed: so may the openings
        this.ensureIndexCapacity(mesh.nFaces);
        chunk.upload(this.gl, mesh, this.indexBuffer);
        chunk.uploadCoarse(this.gl, null); // drawn with its real voxels until the workers send the new coarse mesh
        const water = buildWaterMesh(padded, column.heights, chunk.pos);
        if (water) this.ensureIndexCapacity(water.nFaces);
        chunk.uploadWater(this.gl, water, this.indexBuffer);
    }

    /** grow the index buffer shared by all chunks: 2 triangles (6 indices) per face of 4 vertices */
    ensureIndexCapacity(nFaces) {
        const gl = this.gl;
        if (nFaces <= this.indexCapacity) return;
        let capacity = Math.max(1 << 15, this.indexCapacity);
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

    // ---------------------------------------------------------------- horizon

    /** ask for a new height map when the camera has moved away from the center of the current one */
    updateHorizon(camPosition) {
        if (this.horizonPending) return;
        if (this.horizonCenter && Math.hypot(camPosition[0] - this.horizonCenter[0], camPosition[1] - this.horizonCenter[1]) < HORIZON_REFRESH) return;
        const half = (HORIZON_SIZE - 1) / 2 * HORIZON_STEP;
        const x0 = Math.round(camPosition[0] / HORIZON_STEP) * HORIZON_STEP - half;
        const y0 = Math.round(camPosition[1] / HORIZON_STEP) * HORIZON_STEP - half;
        this.horizonPending = true;
        this.pool.postHeightGrid({ id: ++this.horizonRequest, x0, y0, n: HORIZON_SIZE, step: HORIZON_STEP });
    }

    applyHeightGrid(grid) {
        const gl = this.gl;
        this.horizonPending = false;
        if (grid.id !== this.horizonRequest) return;
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.horizonTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.n, grid.n, gl.RED_INTEGER, gl.SHORT, grid.heights);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.activeTexture(gl.TEXTURE0);
        this.horizonOrigin[0] = grid.x0;
        this.horizonOrigin[1] = grid.y0;
        const half = (grid.n - 1) / 2 * grid.step;
        this.horizonCenter = [grid.x0 + half, grid.y0 + half];
        this.horizonValid = true;
    }

    // ---------------------------------------------------------------- shadow window

    moveWindow() {
        const [ccx, ccy] = this.camColumn;
        const wx = ccx - HALF_WINDOW, wy = ccy - HALF_WINDOW;
        this.windowColumn = [wx, wy];
        vec3.set(this.windowMin, wx * CHUNK_SIZE, wy * CHUNK_SIZE, WORLD_BOTTOM);
        this.brickOrigin.set([mod(wx, WINDOW) * BRICKS, mod(wy, WINDOW) * BRICKS, 0]);
        this.coarseOrigin.set([mod(wx, WINDOW) * COARSE, mod(wy, WINDOW) * COARSE, 0]);

        for (let cx = wx; cx < wx + WINDOW; cx++) {
            for (let cy = wy; cy < wy + WINDOW; cy++) {
                const slot = mod(cx, WINDOW) * WINDOW + mod(cy, WINDOW);
                const key = insideWorld(cx, cy) ? columnKey(cx, cy) : -1;
                if (this.slotOwner[slot] === key) continue;
                const column = key >= 0 ? this.columns.get(key) : null;
                if (column && column.chunks) {
                    this.uploadToWindow(column);
                } else if (this.slotOwner[slot] !== -1) {
                    this.uploadSlot(cx, cy, null); // stale column: empty until the right one is loaded
                    this.slotOwner[slot] = -1;
                }
            }
        }
    }

    uploadToWindow(column) {
        const [wx, wy] = this.windowColumn;
        if (column.cx < wx || column.cx >= wx + WINDOW || column.cy < wy || column.cy >= wy + WINDOW) return;
        this.uploadSlot(column.cx, column.cy, column.chunks);
        this.slotOwner[mod(column.cx, WINDOW) * WINDOW + mod(column.cy, WINDOW)] = column.key;
    }

    uploadSlot(cx, cy, chunks) {
        const gl = this.gl;
        const sx = mod(cx, WINDOW), sy = mod(cy, WINDOW);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (let i = 0; i < CHUNKS_PER_COLUMN; i++) {
            const chunk = chunks ? chunks[i] : null;
            const bricks = chunk ? (chunk.bricks || (chunk.uniform ? FULL_BRICKS : ZERO_BRICKS)) : ZERO_BRICKS;
            const coarse = chunk ? (chunk.coarse || (chunk.uniform ? FULL_COARSE : ZERO_COARSE)) : ZERO_COARSE;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_3D, this.brickTexture);
            gl.texSubImage3D(gl.TEXTURE_3D, 0, sx * BRICKS, sy * BRICKS, i * BRICKS, BRICKS, BRICKS, BRICKS,
                gl.RED_INTEGER, gl.UNSIGNED_BYTE, bricks);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, this.coarseTexture);
            gl.texSubImage3D(gl.TEXTURE_3D, 0, sx * COARSE, sy * COARSE, i * COARSE, COARSE, COARSE, COARSE,
                gl.RED_INTEGER, gl.UNSIGNED_BYTE, coarse);
        }
        gl.activeTexture(gl.TEXTURE0);
    }

    // ---------------------------------------------------------------- interaction

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

    boom(center, radius) {
        if (!center) return;
        this.removeTrees(center, radius);
        const changed = [];
        const affected = [];
        const lo = [0, 1, 2].map(i => Math.floor((center[i] - radius - 2) / CHUNK_SIZE));
        const hi = [0, 1, 2].map(i => Math.floor((center[i] + radius + 2) / CHUNK_SIZE));
        for (let cx = lo[0]; cx <= hi[0]; cx++) {
            for (let cy = lo[1]; cy <= hi[1]; cy++) {
                if (!insideWorld(cx, cy)) continue;
                const column = this.columns.get(columnKey(cx, cy));
                if (!column || !column.chunks) continue; // only loaded columns can be destroyed
                for (let cz = Math.max(lo[2], CZ_MIN); cz <= Math.min(hi[2], CZ_MAX); cz++) {
                    const chunk = column.chunks[cz - CZ_MIN];
                    if (chunk.intersectsSphere(center, radius) && chunk.boom(center, radius)) changed.push(chunk);
                    // faces and ambient occlusion also depend on the voxels next to the removed ones
                    if (chunk.intersectsSphere(center, radius + 2)) affected.push(chunk);
                }
            }
        }
        if (changed.length === 0) return;
        for (const chunk of affected) {
            this.remesh(chunk);
        }
        const columns = new Set(changed.map(chunk => this.columns.get(columnKey(chunk.cx, chunk.cy))));
        for (const column of columns) this.uploadToWindow(column);

        // the light changes up to 15 voxels around: the workers mesh again the columns there, with the light;
        // meshes requested before this explosion are dropped (version)
        const reach = radius + LIGHT_MARGIN;
        for (let cx = Math.floor((center[0] - reach) / CHUNK_SIZE); cx <= Math.floor((center[0] + reach) / CHUNK_SIZE); cx++) {
            for (let cy = Math.floor((center[1] - reach) / CHUNK_SIZE); cy <= Math.floor((center[1] + reach) / CHUNK_SIZE); cy++) {
                if (!insideWorld(cx, cy)) continue;
                const column = this.columns.get(columnKey(cx, cy));
                if (!column || !column.chunks || !column.hasMesh) continue;
                column.editVersion++;
                column.needsRemesh = true;
                this.queue.push({ cx, cy, distance: 0, mesh: true });
            }
        }
    }

    // ---------------------------------------------------------------- rendering

    /**
     * Cave culling: breadth first traversal of the chunks from the camera, through the faces connected by air
     * (never going back in a direction already taken, and only inside the frustum). Marks the reached chunks.
     */
    traverseVisibility(camPosition) {
        const frame = ++this.frame;
        const [ccx, ccy] = this.camColumn;
        const maxDistance = this.viewRadius + 1;
        const camCz = Math.max(CZ_MIN, Math.min(CZ_MAX, Math.floor(camPosition[2] / CHUNK_SIZE)));
        const queue = this.visibilityQueue;
        queue.length = 0;
        // node: cx, cy, cz, face it was entered through (-1 for the camera chunk), directions taken
        queue.push(ccx, ccy, camCz, -1, 0);
        this.visitedFrame.set(chunkKey(ccx, ccy, camCz), frame);
        const min = vec3.create(), max = vec3.create();

        for (let head = 0; head < queue.length; head += 5) {
            const cx = queue[head], cy = queue[head + 1], cz = queue[head + 2], from = queue[head + 3], dirs = queue[head + 4];
            const chunk = this.chunkAt(cx, cy, cz); // null when not loaded: treated as air
            if (chunk) chunk.visibleFrame = frame;
            for (let f = 0; f < 6; f++) {
                if (dirs & (1 << (f ^ 1))) continue; // opposite of a direction already taken
                if (from >= 0 && chunk && chunk.connectivity && !(chunk.connectivity[from] & (1 << f))) continue;
                const axis = f >> 1, sign = (f & 1) ? -1 : 1;
                const nx = cx + (axis === 0 ? sign : 0), ny = cy + (axis === 1 ? sign : 0), nz = cz + (axis === 2 ? sign : 0);
                if (nz < CZ_MIN || nz > CZ_MAX || !insideWorld(nx, ny)) continue;
                if (Math.abs(nx - ccx) > maxDistance || Math.abs(ny - ccy) > maxDistance) continue;
                const key = chunkKey(nx, ny, nz);
                if (this.visitedFrame.get(key) === frame) continue;
                vec3.set(min, nx * CHUNK_SIZE, ny * CHUNK_SIZE, nz * CHUNK_SIZE);
                vec3.set(max, min[0] + CHUNK_SIZE, min[1] + CHUNK_SIZE, min[2] + CHUNK_SIZE);
                if (!aabbInFrustum(this.planes, min, max)) continue;
                this.visitedFrame.set(key, frame);
                queue.push(nx, ny, nz, f ^ 1, dirs | (1 << f)); // entered through the opposite face
            }
        }
        if (this.visitedFrame.size > 100000) this.visitedFrame.clear();
    }

    /**
     * Chunks for the planar reflection of the water: meshed, above the water level, inside the frustum of the mirrored
     * view, from the nearest to the farthest seen from the mirrored camera. No cave culling (the mirrored camera is
     * under the ground).
     */
    cullReflection(viewProj, camPosition) {
        const planes = new Float32Array(24);
        frustumPlanes(planes, viewProj);
        const visible = [];
        for (const column of this.columns.values()) {
            if (!column.hasMesh || !column.chunks) continue;
            for (const chunk of column.chunks) {
                if (chunk.nFaces > 0 && chunk.aabbMax[2] > SEA_LEVEL && aabbInFrustum(planes, chunk.aabbMin, chunk.aabbMax)) {
                    chunk.reflectionDist2 = vec3.sqrDist(chunk.centerPos, camPosition);
                    visible.push(chunk);
                }
            }
        }
        return visible.sort((c1, c2) => c1.reflectionDist2 - c2.reflectionDist2);
    }

    /**
     * Meshed chunks inside the camera frustum (and reached by the cave culling), from the nearest to the farthest.
     * @param occlusion the depth pre-pass tests the chunks this frame (see draw); chunk.occluded: skipped by the passes
     */
    cull(viewProj, camPosition, occlusion) {
        const planes = frustumPlanes(this.planes, viewProj);
        this.updateViewVolume(viewProj);
        if (this.caveCulling) this.traverseVisibility(camPosition);
        occlusion = occlusion && this.occlusionCulling;
        this.pollOcclusion();
        const frame = ++this.cullFrame;
        const visible = this.visible;
        visible.length = 0;
        this.occluded = 0;
        for (const column of this.columns.values()) {
            if (!column.hasMesh || !column.chunks) continue;
            for (const chunk of column.chunks) {
                if (this.caveCulling && chunk.visibleFrame !== this.frame) continue;
                if (chunk.nFaces > 0 && aabbInFrustum(planes, chunk.aabbMin, chunk.aabbMax)) {
                    chunk.camDist2 = vec3.sqrDist(chunk.centerPos, camPosition);
                    // back in the view, or no test: unknown, so drawn (the answers of older tests are ignored)
                    if (!occlusion || chunk.culledFrame !== frame - 1) {
                        chunk.occluded = false;
                        chunk.occlusionEpoch++;
                    }
                    chunk.culledFrame = frame;
                    chunk.occlusionTest = occlusion && boxDistance(chunk.aabbMin, chunk.aabbMax, camPosition) > OCCLUSION_NEAR;
                    if (chunk.occluded && (!chunk.occlusionTest
                        || !this.seenByTest(chunk.aabbMin, chunk.aabbMax, chunk.occlusionPlanes, 0, camPosition))) {
                        chunk.occluded = false;
                    }
                    if (chunk.occluded) this.occluded++;
                    visible.push(chunk);
                }
            }
        }
        visible.sort((c1, c2) => c1.camDist2 - c2.camDist2);
        return visible;
    }

    /** unit frustum planes and side edges of the view (seenByTest) */
    updateViewVolume(viewProj) {
        const planes = this.viewPlanes;
        planes.set(this.planes);
        for (let p = 0; p < 24; p += 4) {
            const length = Math.hypot(planes[p], planes[p + 1], planes[p + 2]);
            for (let k = 0; k < 4; k++) planes[p + k] /= length;
        }
        const m = mat4.invert(this.invViewProj, viewProj), edges = this.viewEdges;
        const unproject = (out, o, x, y, z) => {
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            for (let k = 0; k < 3; k++) out[o + k] = (m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k]) / w;
        };
        for (let e = 0; e < 4; e++) {
            const x = (e & 1) ? 1 : -1, y = (e & 2) ? 1 : -1, o = e * 6;
            unproject(edges, o, x, y, -1);
            unproject(edges, o + 3, x, y, 1);
            for (let k = 0; k < 3; k++) edges[o + 3 + k] -= edges[o + k];
        }
    }

    /**
     * Was all of the box [min, max] that is in the view now also in the view of the test that found it occluded (its
     * frustum planes: before, from offset)? The box clipped by the frustum is convex: it is enough that its vertices
     * were in the view of the test. Its vertices are the corners of the box inside the frustum, the crossings of the box
     * edges with the frustum planes, and the crossings of the frustum side edges with the box faces (the near and far
     * corners are never in a tested box).
     */
    seenByTest(min, max, before, offset, eye) {
        const now = this.viewPlanes;
        let same = true;
        for (let k = 0; k < 24 && same; k++) same = before[offset + k] === now[k];
        if (same) return true; // the camera did not move
        if (insidePlanes(before, offset, min, max)) return true; // the whole box was in the view of the test
        // a vertex of the box clipped by the view, now in the view but not before
        const newlySeen = (x, y, z) => pointInPlanes(now, 0, x, y, z, 1e-3)
            && !pointInPlanes(before, offset, x, y, z, 1e-3 + OCCLUSION_SLIVER * Math.hypot(x - eye[0], y - eye[1], z - eye[2]));
        const c = [0, 0, 0];
        for (let i = 0; i < 8; i++) {
            if (newlySeen((i & 1) ? max[0] : min[0], (i & 2) ? max[1] : min[1], (i & 4) ? max[2] : min[2])) return false;
        }
        for (let a = 0; a < 3; a++) {
            const b = (a + 1) % 3, d = (a + 2) % 3;
            for (let i = 0; i < 4; i++) {
                c[b] = (i & 1) ? max[b] : min[b];
                c[d] = (i & 2) ? max[d] : min[d];
                for (let p = 0; p < 24; p += 4) {
                    if (Math.abs(now[p + a]) < 1e-9) continue;
                    c[a] = -(now[p + b] * c[b] + now[p + d] * c[d] + now[p + 3]) / now[p + a];
                    if (c[a] >= min[a] && c[a] <= max[a] && newlySeen(c[0], c[1], c[2])) return false;
                }
            }
        }
        const edges = this.viewEdges;
        for (let o = 0; o < 24; o += 6) {
            for (let a = 0; a < 3; a++) {
                const v = edges[o + 3 + a];
                if (Math.abs(v) < 1e-9) continue;
                for (const face of [min[a], max[a]]) {
                    const t = (face - edges[o + a]) / v;
                    if (t < 0 || t > 1) continue;
                    let inside = true;
                    for (let k = 0; k < 3; k++) {
                        c[k] = k === a ? face : edges[o + k] + t * edges[o + 3 + k];
                        if (k !== a && (c[k] < min[k] - 1e-3 || c[k] > max[k] + 1e-3)) inside = false;
                    }
                    if (inside && newlySeen(c[0], c[1], c[2])) return false;
                }
            }
        }
        return true;
    }

    /** answers of the occlusion tests that have arrived */
    pollOcclusion() {
        const gl = this.gl, pending = this.pendingOcclusion;
        let n = 0;
        for (const test of pending) {
            if (!gl.getQueryParameter(test.query, gl.QUERY_RESULT_AVAILABLE)) {
                pending[n++] = test;
                continue;
            }
            const chunk = test.chunk, trees = test.trees, i = test.index;
            if (chunk) {
                if (chunk.occlusionEpoch === test.epoch) {
                    chunk.occluded = !gl.getQueryParameter(test.query, gl.QUERY_RESULT);
                    [chunk.occlusionPlanes, chunk.queryPlanes] = [chunk.queryPlanes, chunk.occlusionPlanes];
                }
                chunk.occlusionQuery = null;
            } else {
                if (trees.epoch[i] === test.epoch) {
                    trees.occluded[i] = gl.getQueryParameter(test.query, gl.QUERY_RESULT) ? 0 : 1;
                    trees.planes.set(trees.queryPlanes.subarray(i * 24, i * 24 + 24), i * 24);
                }
                trees.pending[i] = 0;
            }
            this.occlusionQueries.push(test.query);
        }
        pending.length = n;
    }

    /** occlusion query on the (grown) box of the chunk, against the depth of the chunks drawn so far; nothing written */
    testOcclusion(chunk, locations, pixelAngle) {
        const gl = this.gl;
        const query = this.occlusionQueries.pop() || gl.createQuery();
        const margin = OCCLUSION_MARGIN + Math.sqrt(chunk.camDist2) * pixelAngle * OCCLUSION_PIXELS;
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.uniform3f(locations.chunkOrigin, chunk.pos[0] - margin, chunk.pos[1] - margin, chunk.pos[2] - margin);
        gl.uniform1f(locations.chunkScale, CHUNK_SIZE + 2 * margin);
        gl.bindVertexArray(this.boxArray);
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
        gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_BYTE, 0);
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        chunk.occlusionQuery = query;
        chunk.queryPlanes.set(this.viewPlanes);
        this.pendingOcclusion.push({ query, chunk, trees: null, index: 0, epoch: chunk.occlusionEpoch });
    }

    /**
     * Occlusion state of a tree in the view this frame (trees.js), with the rules of the chunks (cull): state from
     * createTreeOcclusion, tree i, box [min, max]. @returns true when the tree must be tested this frame (testTrees)
     */
    updateTreeOcclusion(state, i, min, max, eye) {
        if (state.culledFrame[i] !== this.cullFrame - 1) {
            state.occluded[i] = 0;
            state.epoch[i]++;
        }
        state.culledFrame[i] = this.cullFrame;
        const testable = boxDistance(min, max, eye) > OCCLUSION_NEAR;
        if (state.occluded[i] && (!testable || !this.seenByTest(min, max, state.planes, i * 24, eye))) state.occluded[i] = 0;
        return testable && !state.pending[i];
    }

    /**
     * Occlusion queries on the boxes of the trees gathered for a test (trees.js), against the depth drawn so far: the
     * terrain of the pre-pass, before the trees. program: viewProj, boxMin, boxSize (box_vertex.glsl).
     */
    testTrees(tests, program, viewProj, eye, pixelAngle) {
        if (tests.count === 0) return;
        const gl = this.gl, locations = program.locations, b = tests.boxes;
        gl.useProgram(program.program);
        gl.uniformMatrix4fv(locations.viewProj, false, viewProj);
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.bindVertexArray(this.boxArray);
        for (let k = 0; k < tests.count; k++) {
            const o = k * 6, state = tests.states[k], i = tests.indices[k];
            const distance = Math.hypot((b[o] + b[o + 3]) / 2 - eye[0], (b[o + 1] + b[o + 4]) / 2 - eye[1], (b[o + 2] + b[o + 5]) / 2 - eye[2]);
            const margin = OCCLUSION_MARGIN + distance * pixelAngle * OCCLUSION_PIXELS;
            gl.uniform3f(locations.boxMin, b[o] - margin, b[o + 1] - margin, b[o + 2] - margin);
            gl.uniform3f(locations.boxSize, b[o + 3] - b[o] + 2 * margin, b[o + 4] - b[o + 1] + 2 * margin, b[o + 5] - b[o + 2] + 2 * margin);
            const query = this.occlusionQueries.pop() || gl.createQuery();
            gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
            gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_BYTE, 0);
            gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
            state.pending[i] = 1;
            state.queryPlanes.set(this.viewPlanes, i * 24);
            this.pendingOcclusion.push({ query, chunk: null, trees: state, index: i, epoch: state.epoch[i] });
        }
        gl.bindVertexArray(null);
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
    }

    /**
     * @param locations of the program: chunkOrigin, chunkScale (1, or 2 for the coarse meshes of the far chunks)
     * @param pixelAngle the depth pre-pass, when not 0 (angle of its pixels, in radians): the occluded chunks are skipped,
     * and the chunks to test are tested right before being drawn
     * @param reflection the reflection of the water: coarse meshes from REFLECTION_FAR_DISTANCE
     * @returns the number of faces drawn
     */
    draw(chunks, camPosition, locations, pixelAngle = 0, reflection = false) {
        const gl = this.gl;
        let faces = 0;
        for (const chunk of chunks) {
            if (pixelAngle > 0) {
                if (chunk.occlusionTest && chunk.occlusionQuery === null) this.testOcclusion(chunk, locations, pixelAngle);
                if (chunk.occluded) continue;
            }
            // horizontal distance to the chunk (the mirrored eye of the reflection gives the same)
            const dx = Math.max(chunk.aabbMin[0] - camPosition[0], 0, camPosition[0] - chunk.aabbMax[0]);
            const dy = Math.max(chunk.aabbMin[1] - camPosition[1], 0, camPosition[1] - chunk.aabbMax[1]);
            const d = Math.hypot(dx, dy);
            let coarse;
            if (reflection) {
                if (d > REFLECTION_FAR_DISTANCE + FAR_HYSTERESIS) chunk.reflectionFar = true;
                else if (d < REFLECTION_FAR_DISTANCE - FAR_HYSTERESIS) chunk.reflectionFar = false;
                coarse = chunk.reflectionFar && chunk.hasCoarse;
            } else {
                if (d > FAR_DISTANCE + FAR_HYSTERESIS) chunk.far = true;
                else if (d < FAR_DISTANCE - FAR_HYSTERESIS) chunk.far = false;
                coarse = chunk.far && chunk.hasCoarse;
            }
            gl.uniform3fv(locations.chunkOrigin, chunk.pos);
            gl.uniform1f(locations.chunkScale, coarse ? 2 : 1);
            faces += chunk.draw(gl, camPosition, this.multiDraw, coarse);
        }
        gl.bindVertexArray(null);
        return faces;
    }

    stats() {
        let meshed = 0, loaded = 0;
        for (const column of this.columns.values()) {
            if (column.chunks) loaded++;
            if (column.hasMesh) meshed++;
        }
        return { loaded, meshed, pending: this.queue.length + this.pool.pending + this.results.length };
    }
}


/** is the point inside the planes (unit normals, from offset), give or take slack? */
function pointInPlanes(planes, offset, x, y, z, slack) {
    for (let p = offset; p < offset + 24; p += 4) {
        if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -slack) return false;
    }
    return true;
}

/** is the whole box [min, max] inside the planes (from offset)? */
function insidePlanes(planes, offset, min, max) {
    for (let p = offset; p < offset + 24; p += 4) {
        const a = planes[p], b = planes[p + 1], c = planes[p + 2];
        // corner of the box the least along the plane normal
        if (a * (a > 0 ? min[0] : max[0]) + b * (b > 0 ? min[1] : max[1]) + c * (c > 0 ? min[2] : max[2]) + planes[p + 3] < 0) {
            return false;
        }
    }
    return true;
}

/** distance from the point to the box [min, max] (0 inside) */
function boxDistance(min, max, p) {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
        const d = Math.max(min[i] - p[i], 0, p[i] - max[i]);
        d2 += d * d;
    }
    return Math.sqrt(d2);
}

/**
 * Unit cube in the packed vertex format of the chunk meshes (corners at 0 or 1, scaled by chunkScale), its triangles
 * counter-clockwise seen from outside: the boxes of the occlusion tests.
 */
function createBoxArray(gl) {
    const vertices = new Uint32Array(8);
    for (let i = 0; i < 8; i++) vertices[i] = (i & 1) | ((i >> 1) & 1) << 7 | ((i >> 2) & 1) << 14;
    const indices = [];
    for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3, v = (axis + 2) % 3; // u x v = axis
        for (const side of [0, 1]) {
            const corner = (a, b) => (side << axis) | (a << u) | (b << v);
            const quad = side
                ? [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]
                : [corner(0, 0), corner(0, 1), corner(1, 1), corner(1, 0)];
            indices.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
        }
    }
    const vertexArray = gl.createVertexArray();
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return vertexArray;
}

function chunkKey(cx, cy, cz) {
    return columnKey(cx, cy) * CHUNKS_PER_COLUMN + (cz - CZ_MIN);
}

function mod(a, n) {
    return ((a % n) + n) % n;
}

const HORIZON_STEP = 16;
const HORIZON_SIZE = 257; // samples per side: 4096 voxels
const HORIZON_REFRESH = 512;

function createHeightTexture(gl, unit, size) {
    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16I, size, size);
    gl.activeTexture(gl.TEXTURE0);
    return texture;
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
    gl.activeTexture(gl.TEXTURE0);
    return texture;
}
