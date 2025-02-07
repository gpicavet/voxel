import alea from 'alea';
import { vec3 } from "gl-matrix";
import { createNoise3D } from "simplex-noise";
import { Chunk } from "./chunk";

export class Terrain {
    constructor(dim) {
        this.dim = dim;
        this.chunks = [];
        this.voxelTexture = null;
    }

    init(gl) {
        const noise3D = createNoise3D(alea('0'));

        console.log("generating chunks")

        const cx = Math.floor(this.dim[0] / 2);
        const cy = Math.floor(this.dim[1] / 2);
        const cz = Math.floor(this.dim[2] / 2);

        this.chunks = new Array(this.dim[0]);
        for (var x = 0; x < this.dim[0]; x++) {
            this.chunks[x] = new Array(this.dim[1]);
            for (var y = 0; y < this.dim[1]; y++) {
                this.chunks[x][y] = new Array(this.dim[2]);
                for (var z = 0; z < this.dim[2]; z++) {
                    const chunk = new Chunk(
                        vec3.fromValues((x - cx) << Chunk.SIZE_POW, (y - cy) << Chunk.SIZE_POW, (z - cz) << Chunk.SIZE_POW));
                    this.chunks[x][y][z] = chunk;
                    chunk.init(noise3D);
                    chunk.createArray(gl);
                }
            }
        }

        console.log("generating 3D texture")

        gl.activeTexture(gl.TEXTURE0);

        this.voxelTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, this.voxelTexture);

        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

        const terrainData = new Uint8Array(this.dim[0] * Chunk.SIZE * this.dim[1] * Chunk.SIZE * this.dim[2] * Chunk.SIZE);
        var offs = 0;

        // Charger les données du terrain dans la texture 3D
        for (var z = 0; z < this.dim[2] * Chunk.SIZE; z++) {
            for (var y = 0; y < this.dim[1] * Chunk.SIZE; y++) {
                for (var x = 0; x < this.dim[0] * Chunk.SIZE; x++) {
                    const cz = (z >> Chunk.SIZE_POW);
                    const cy = (y >> Chunk.SIZE_POW);
                    const cx = (x >> Chunk.SIZE_POW);
                    const vx = x & (Chunk.SIZE - 1);
                    const vy = y & (Chunk.SIZE - 1);
                    const vz = z & (Chunk.SIZE - 1);
                    terrainData[offs++] = this.chunks[cx][cy][cz].getVoxel(vx, vy, vz);
                }
            }
        }

        gl.texImage3D(gl.TEXTURE_3D, 0,
            gl.R8UI,
            this.dim[0] * Chunk.SIZE, this.dim[1] * Chunk.SIZE, this.dim[2] * Chunk.SIZE,
            0, gl.RED_INTEGER, gl.UNSIGNED_BYTE,
            terrainData);
    }

    updateTexture(chunks, gl) {
        console.log("updating 3D texture")

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, this.voxelTexture);


        // Charger les données du terrain dans la texture 3D
        for (var chunk of chunks) {
            const terrainData = new Uint8Array(Chunk.SIZE * Chunk.SIZE * Chunk.SIZE);
            var offs = 0;

            for (var z = 0; z < Chunk.SIZE; z++) {
                for (var y = 0; y < Chunk.SIZE; y++) {
                    for (var x = 0; x < Chunk.SIZE; x++) {
                        terrainData[offs++] = chunk.getVoxel(x, y, z);
                    }
                }
            }
            gl.texSubImage3D(gl.TEXTURE_3D, 0,
                chunk.pos[0] + Math.floor(this.dim[0] / 2) * Chunk.SIZE,
                chunk.pos[1] + Math.floor(this.dim[1] / 2) * Chunk.SIZE,
                chunk.pos[2] + Math.floor(this.dim[2] / 2) * Chunk.SIZE,
                Chunk.SIZE, Chunk.SIZE, Chunk.SIZE,
                gl.RED_INTEGER, gl.UNSIGNED_BYTE,
                terrainData);
        }


    }

    intersection(from, dir) {
        var chunksSortedByDist = [];
        for (var x = 0; x < this.dim[0]; x++) {
            for (var y = 0; y < this.dim[1]; y++) {
                for (var z = 0; z < this.dim[2]; z++) {
                    const chunk = this.chunks[x][y][z];
                    const res = chunk.bbIntersectionWithRay(from, dir);
                    //console.log(chunk.pos[0], chunk.pos[1], chunk.pos[2], " : ", res[0], res[1], res[2]);
                    if (res.dist !== Infinity && res.dist >= 0) {
                        chunksSortedByDist.push({ chunk, res });
                    }
                }
            }
        }
        chunksSortedByDist.sort((c1, c2) => c1.res.dist - c2.res.dist);

        for (var chunk of chunksSortedByDist) {
            const res = chunk.chunk.voxelIntersection(from, dir);
            if (res) {
                return { chunk: chunk.chunk, res };
            }
        }

        return null;
    }

    boom(gl, center, radius) {
        if (!center)
            return;

        var chunksInter = [];
        for (var x = 0; x < this.dim[0]; x++) {
            for (var y = 0; y < this.dim[1]; y++) {
                for (var z = 0; z < this.dim[2]; z++) {
                    const chunk = this.chunks[x][y][z];

                    if (chunk.bbIntersectionWithSphere(center, radius)) {
                        const res = chunk.boom(center, 10);
                        if (res) {
                            chunk.createArray(gl);
                        }
                    }
                }
            }
        }

        if (chunksInter.length > 0)
            this.updateTexture(chunksInter, gl);

    }

    draw(gl, camPosition) {
        //we render chunk from the nearest to the farthest, so we better use the depth buffer to limit fragment shader useless overdraw
        //TODO: dont render chunks outside camera frustrum
        var chunkSortedByDist = [];
        for (var x = 0; x < this.dim[0]; x++) {
            for (var y = 0; y < this.dim[1]; y++) {
                for (var z = 0; z < this.dim[2]; z++) {
                    chunkSortedByDist.push(this.chunks[x][y][z]);
                }
            }
        }

        chunkSortedByDist.sort((c1, c2) => {
            const c1Center = c1.center();
            const c2Center = c2.center();
            const c1CenterToCam = vec3.fromValues(camPosition[0] - c1Center[0], camPosition[1] - c1Center[1], camPosition[2] - c1Center[2]);
            const c2CenterToCam = vec3.fromValues(camPosition[0] - c2Center[0], camPosition[1] - c2Center[1], camPosition[2] - c2Center[2]);
            const c1dist2 = vec3.dot(c1CenterToCam, c1CenterToCam);
            const c2dist2 = vec3.dot(c2CenterToCam, c2CenterToCam);
            return c1dist2 - c2dist2;
        });

        for (const chunk of chunkSortedByDist) {
            chunk.draw(gl);
        }
    }
}