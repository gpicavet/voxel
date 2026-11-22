import { MODEL_SPECIES, TREE_FLOATS } from './treePlacement';

// Canopy map: what the foliage of the trees hides of the sky, on a grid of 1 m around the camera (texture unit 20).
// Per cell: density x crown bottom, density x crown top, density, trunk contact. Weighting the heights by the density
// keeps the mipmaps meaningful (bottom = r / b, top = g / b): the coarse levels give the forest around a point.
// Read by canopy.glsl for the sky light of the terrain and of the trees.

const SIZE = 512;           // cells per side (1 m)
const RECENTER = 64;        // the map follows the camera by steps of this many meters
const MIN_INTERVAL = 300;   // ms between two rebuilds when trees appear or disappear (streaming)
const SPECIES_DENSITY = [0.85, 0.85, 0.6, 0.85, 0]; // oak, pine, birch, bush, dead tree (no foliage)
const DENSITY = MODEL_SPECIES.map(species => SPECIES_DENSITY[species]);
const CONTACT_RADIUS = 1.6; // darker ground around the trunks, within this distance

export class CanopyMap {
    constructor(gl, unit, crowns) {
        this.gl = gl;
        this.crowns = crowns; // per model: { radius, bottom, top } in meters at scale 1, or null
        this.data = new Float32Array(SIZE * SIZE * 4);
        this.origin = new Float32Array(2);
        this.size = SIZE;
        this.valid = false;
        this.version = -1;
        this.lastBuild = -Infinity;
        gl.activeTexture(unit);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        const levels = Math.log2(SIZE) + 1;
        gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, SIZE, SIZE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
    }

    /** rebuild when the trees changed (at most every MIN_INTERVAL) or the camera went far from the center */
    update(world, camPosition) {
        const now = performance.now();
        const half = SIZE / 2;
        const far = !this.valid || Math.abs(camPosition[0] - (this.origin[0] + half)) > RECENTER
            || Math.abs(camPosition[1] - (this.origin[1] + half)) > RECENTER;
        const changed = (world.treesVersion !== this.version || !this.valid) && now - this.lastBuild > MIN_INTERVAL;
        if (!far && !changed) return;
        this.version = world.treesVersion;
        this.lastBuild = now;
        if (far) {
            this.origin[0] = Math.round(camPosition[0] / RECENTER) * RECENTER - half;
            this.origin[1] = Math.round(camPosition[1] / RECENTER) * RECENTER - half;
        }
        this.build(world);
    }

    build(world) {
        const gl = this.gl, data = this.data;
        if (!this.crowns) return; // the tree models are not built yet
        const [ox, oy] = this.origin;
        data.fill(0);
        for (const column of world.columns.values()) {
            const trees = column.trees;
            if (!trees || trees.ids.length === 0) continue;
            const b = trees.bounds;
            if (b[3] < ox || b[4] < oy || b[0] > ox + SIZE || b[1] > oy + SIZE) continue;
            const d = trees.data;
            for (let i = 0; i < trees.ids.length; i++) {
                const o = i * TREE_FLOATS;
                const model = d[o + 8], crown = this.crowns[model];
                const tx = d[o] - ox, ty = d[o + 1] - oy, tz = d[o + 2], scale = d[o + 4];
                if (crown && DENSITY[model] > 0) {
                    const r = crown.radius * scale, bottom = tz + crown.bottom * scale, top = tz + crown.top * scale;
                    for (let y = Math.max(0, Math.floor(ty - r)); y <= Math.min(SIZE - 1, Math.ceil(ty + r)); y++) {
                        for (let x = Math.max(0, Math.floor(tx - r)); x <= Math.min(SIZE - 1, Math.ceil(tx + r)); x++) {
                            const q = ((x + 0.5 - tx) ** 2 + (y + 0.5 - ty) ** 2) / (r * r);
                            if (q >= 1) continue;
                            const w = DENSITY[model] * Math.sqrt(1 - q); // thinner at the edge of the crown
                            const c = (y * SIZE + x) * 4;
                            data[c] += w * bottom;
                            data[c + 1] += w * top;
                            data[c + 2] += w;
                        }
                    }
                }
                // contact around the trunk (dead trees too)
                for (let y = Math.max(0, Math.floor(ty - CONTACT_RADIUS)); y <= Math.min(SIZE - 1, Math.ceil(ty + CONTACT_RADIUS)); y++) {
                    for (let x = Math.max(0, Math.floor(tx - CONTACT_RADIUS)); x <= Math.min(SIZE - 1, Math.ceil(tx + CONTACT_RADIUS)); x++) {
                        const dist = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
                        const c = (y * SIZE + x) * 4 + 3;
                        data[c] = Math.max(data[c], Math.max(0, 1 - dist / CONTACT_RADIUS) * Math.min(scale, 1));
                    }
                }
            }
        }
        // overlapping crowns: density at most 1, heights averaged
        for (let c = 0; c < data.length; c += 4) {
            if (data[c + 2] > 1) {
                const k = 1 / data[c + 2];
                data[c] *= k;
                data[c + 1] *= k;
                data[c + 2] = 1;
            }
        }
        gl.activeTexture(gl.TEXTURE20);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIZE, SIZE, gl.RGBA, gl.FLOAT, data);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.activeTexture(gl.TEXTURE0);
        this.valid = true;
    }
}
