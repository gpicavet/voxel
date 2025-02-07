import { vec3 } from "gl-matrix";
import { aabbRayIntersection } from "./utils";

export class Chunk {
    static SIZE_POW = 6;//size = 64
    static SIZE = 1 << Chunk.SIZE_POW;
    static SIZE_HALF = Chunk.SIZE >> 1;

    constructor(pos) {
        this.pos = pos;
        this.voxels = new Array(Chunk.SIZE * Chunk.SIZE * Chunk.SIZE);
        this.vertexArray = null;
        this.positionBuffer = null;
        this.normalBuffer = null;
        this.colorBuffer = null;
        this.nElements = 0;
    }

    center() {
        return vec3.fromValues(this.pos[0] + Chunk.SIZE_HALF, this.pos[1] + Chunk.SIZE_HALF, this.pos[2] + Chunk.SIZE_HALF);
    }

    setVoxel(x, y, z, val) {
        this.voxels[(((x << Chunk.SIZE_POW) + y) << Chunk.SIZE_POW) + z] = val;
    }
    getVoxel(x, y, z) {
        return this.voxels[(((x << Chunk.SIZE_POW) + y) << Chunk.SIZE_POW) + z];
    }

    init(noise) {

        for (var x = 0; x < Chunk.SIZE; x++) {
            for (var y = 0; y < Chunk.SIZE; y++) {
                for (var z = 0; z < Chunk.SIZE; z++) {
                    var dens = (noise((this.pos[0] + x) * 0.01,
                        (this.pos[1] + y) * 0.01,
                        (this.pos[2] + z) * 0.01));

                    this.setVoxel(x, y, z, 0);
                    if (z + this.pos[2] == 0 || dens < -0.1) {
                        this.setVoxel(x, y, z, 1);
                    }
                }
            }
        }

    }


    bbIntersectionWithRay(from, dir) {
        var aabb = [
            [this.pos[0], this.pos[1], this.pos[2]],
            [this.pos[0] + Chunk.SIZE, this.pos[1] + Chunk.SIZE, this.pos[2] + Chunk.SIZE],
        ];

        var inside = true;
        for (var i = 0; i < 3; i++)
            if (aabb[0][i] > from[i] || from[i] > aabb[1][i]) {
                inside = false;
                break;
            }

        if (inside) {
            return { dist: 0 };
        } else {
            return { dist: aabbRayIntersection(from, dir, aabb) };
        }
    }

    bbIntersectionWithSphere(center, radius) {
        var aabb = [
            [this.pos[0], this.pos[1], this.pos[2]],
            [this.pos[0] + Chunk.SIZE, this.pos[1] + Chunk.SIZE, this.pos[2] + Chunk.SIZE],
        ];

        const radius2 = radius * radius;
        var dmin = 0;
        for (var i = 0; i < 3; i++) {
            if (center[i] < aabb[0][i])
                dmin += (center[i] - aabb[0][i]) * (center[i] - aabb[0][i]);
            else if (center[i] > aabb[1][i])
                dmin += (center[i] - aabb[1][i]) * (center[i] - aabb[1][i]);
        }
        return dmin <= radius2;
    }

    voxelIntersection(from, dir) {
        var minInter = null;
        for (var x = 0; x < Chunk.SIZE; x++) {
            for (var y = 0; y < Chunk.SIZE; y++) {
                for (var z = 0; z < Chunk.SIZE; z++) {
                    if (this.getVoxel(x, y, z) > 0) {
                        const min = [this.pos[0] + x, this.pos[1] + y, this.pos[2] + z];
                        const max = [min[0] + 1, min[1] + 1, min[2] + 1];
                        const aabb = [
                            min, max
                        ];

                        var inside = true;
                        for (var i = 0; i < 3; i++)
                            if (aabb[0][i] < from[i] || from[i] > aabb[1][i]) {
                                inside = false;
                                break;
                            }

                        if (inside) {
                            const del = [min[0] + 0.5 - from[0], min[1] + 0.5 - from[1], min[2] + 0.5 - from[2]];
                            return { dist: Math.sqrt(del[0] * del[0] + del[1] * del[1] + del[2] * del[2]), point: min };
                        } else {
                            const dist = aabbRayIntersection(from, dir, aabb);
                            if (dist !== Infinity && dist >= 0) {
                                if (minInter == null || minInter.dist > dist) {
                                    const point = [from[0] + dist * dir[0],
                                    from[1] + dist * dir[1],
                                    from[2] + dist * dir[2]];
                                    minInter = { dist, point };
                                }
                            }
                        }
                    }
                }
            }
        }

        return minInter;
    }

    boom(center, radius) {
        if (!center)
            return;

        console.log("boom ", center, radius);

        var changed = false;

        var radius2 = radius * radius;
        var center = vec3.fromValues(center[0] - this.pos[0], center[1] - this.pos[1], center[2] - this.pos[2]);

        for (var x = 0; x < Chunk.SIZE; x++) {
            for (var y = 0; y < Chunk.SIZE; y++) {
                for (var z = 0; z < Chunk.SIZE; z++) {
                    if (this.getVoxel(x, y, z) > 0) {
                        var deltapos = [center[0] - x, center[1] - y, center[2] - z];
                        var dist2 = deltapos[0] * deltapos[0] + deltapos[1] * deltapos[1] + deltapos[2] * deltapos[2];
                        // console.log(deltapos, dist2);
                        if (dist2 < radius2) {
                            this.setVoxel(x, y, z, 0);
                            changed = true;
                        }
                    }
                }
            }
        }

        return changed;
    }

    createArray(gl) {

        const cubevertices = [
            0.5, 0.5, -0.5,
            0.5, 0.5, 0.5,
            0.5, -0.5, 0.5,
            0.5, -0.5, -0.5,
            -0.5, 0.5, -0.5,
            -0.5, 0.5, 0.5,
            -0.5, -0.5, 0.5,
            -0.5, -0.5, -0.5,
        ];

        const cubenormals = [
            1, 0, 0,  // x>0 face
            -1, 0, 0, // x<0 face
            0, 1, 0,  // y>0 face
            0, -1, 0, // y<0 face
            0, 0, 1,  // z>0 face
            0, 0, -1, // z<0 face
        ];

        const cubeindices = [
            [0, 1, 2, 3], // x>0 face
            [5, 4, 7, 6], // x<0 face
            [4, 5, 1, 0], // y>0 face
            [7, 3, 2, 6], // y<0 face
            [1, 5, 6, 2], // z>0 face
            [0, 3, 7, 4], // z<0 face
        ];

        const positions = [];
        const normals = [];
        const colors = [];

        for (var x = 0; x < Chunk.SIZE; x++) {
            for (var y = 0; y < Chunk.SIZE; y++) {
                for (var z = 0; z < Chunk.SIZE; z++) {

                    if (this.getVoxel(x, y, z) > 0) {

                        const visibleFace = [];
                        visibleFace[0] = (x >= Chunk.SIZE - 1 || this.getVoxel(x + 1, y, z) == 0);
                        visibleFace[1] = (x <= 0 || this.getVoxel(x - 1, y, z) == 0);
                        visibleFace[2] = (y >= Chunk.SIZE - 1 || this.getVoxel(x, y + 1, z) == 0);
                        visibleFace[3] = (y <= 0 || this.getVoxel(x, y - 1, z) == 0);
                        visibleFace[4] = (z >= Chunk.SIZE - 1 || this.getVoxel(x, y, z + 1) == 0);
                        visibleFace[5] = (z <= 0 || this.getVoxel(x, y, z - 1) == 0);

                        const visible = visibleFace[0] || visibleFace[1] || visibleFace[2] || visibleFace[3] || visibleFace[4] || visibleFace[5];
                        if (visible) {
                            var wx = x + this.pos[0];
                            var wy = y + this.pos[1];
                            var wz = z + this.pos[2];

                            const colorRock = [0.5, 0.5, 0.5];
                            const colorGrass = [0.1, 1, 0.2];
                            const colorEarth = [0.5, 0.4, 0.3];
                            var color = colorEarth;


                            if (wz > 30) {
                                color = colorRock;
                            }
                            var zz = z + 1;
                            if (zz >= Chunk.SIZE - 1 || this.getVoxel(x, y, zz) == 0) {
                                color = colorGrass;
                            }

                            //simple ambient occlusion
                            const aoFaceNeighborsPosList = [
                                [[+1, 0, -1], [+1, +1, -1], [+1, +1, 0], [+1, +1, +1], [+1, 0, +1], [+1, -1, +1], [+1, -1, 0], [+1, -1, -1]],
                                [[-1, 0, -1], [-1, +1, -1], [-1, +1, 0], [-1, +1, +1], [-1, 0, +1], [-1, -1, +1], [-1, -1, 0], [-1, -1, -1]],
                                [[0, +1, -1], [-1, +1, -1], [-1, +1, 0], [-1, +1, +1], [0, +1, +1], [+1, +1, +1], [+1, +1, 0], [+1, +1, -1]],
                                [[0, -1, -1], [-1, -1, -1], [-1, -1, 0], [-1, -1, +1], [0, -1, +1], [+1, -1, +1], [+1, -1, 0], [+1, -1, -1]],
                                [[+1, 0, +1], [+1, +1, +1], [0, +1, +1], [-1, +1, +1], [-1, 0, +1], [-1, -1, +1], [0, -1, +1], [+1, -1, +1]],
                                [[+1, 0, -1], [+1, +1, -1], [0, +1, -1], [-1, +1, -1], [-1, 0, -1], [-1, -1, -1], [0, -1, -1], [+1, -1, -1]],
                            ]

                            const aoFaceNeighborsOrder = [[0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 0]];

                            const test = (diff) => {
                                const [dx, dy, dz] = diff;
                                return (dx == 0 || (dx < 0 && x > 0) || (dx > 0 && x < Chunk.SIZE - 1)) &&
                                    (dy == 0 || (dy < 0 && y > 0) || (dy > 0 && y < Chunk.SIZE - 1)) &&
                                    (dz == 0 || (dz < 0 && z > 0) || (dz > 0 && z < Chunk.SIZE - 1)) &&
                                    this.getVoxel(x + dx, y + dy, z + dz) > 0;
                            }

                            for (var f = 0; f < 6; f++) {
                                //culling
                                //only create triangles indices for not shared faces (visible face)
                                if (visibleFace[f]) {
                                    const faceIndices = cubeindices[f];
                                    for (const vertIndicePtr of [0, 1, 2, 2, 3, 0]) {
                                        const vertI = faceIndices[vertIndicePtr];
                                        const vertCompOffs = 3 * vertI;
                                        const normCompOffs = 3 * f;

                                        positions.push((0.5 + cubevertices[vertCompOffs + 0]) + wx);
                                        positions.push((0.5 + cubevertices[vertCompOffs + 1]) + wy);
                                        positions.push((0.5 + cubevertices[vertCompOffs + 2]) + wz);

                                        normals.push(cubenormals[normCompOffs + 0]);
                                        normals.push(cubenormals[normCompOffs + 1]);
                                        normals.push(cubenormals[normCompOffs + 2]);

                                        //simple ambient occlusion
                                        const aoFaceNeighborsPoss = aoFaceNeighborsPosList[f];

                                        var ao = 1;
                                        if (f >= 0) {

                                            var side1 = test(aoFaceNeighborsPoss[aoFaceNeighborsOrder[vertIndicePtr][0]]);
                                            var corner = test(aoFaceNeighborsPoss[aoFaceNeighborsOrder[vertIndicePtr][1]]);
                                            var side2 = test(aoFaceNeighborsPoss[aoFaceNeighborsOrder[vertIndicePtr][2]]);

                                            if (side1 && side2) {
                                                ao = 0.25;
                                            }
                                            else if (side1 && corner) {
                                                ao = 0.5;
                                            }
                                            else if (side2 && corner) {
                                                ao = 0.5;
                                            }
                                            else if (side2 || side2 || corner) {
                                                ao = 0.75;
                                            }
                                        }

                                        colors.push((color[0]) * ao);
                                        colors.push((color[1]) * ao);
                                        colors.push((color[2]) * ao);
                                    }
                                }
                            }
                        }
                    }

                }
            }
        }

        var positionsA = new Float32Array(positions);
        var normalsA = new Float32Array(normals);
        var colorsA = new Float32Array(colors);

        if (this.vertexArray == null) {
            this.vertexArray = gl.createVertexArray();
        }
        gl.bindVertexArray(this.vertexArray);

        if (this.positionBuffer != null) {
            gl.deleteBuffer(this.positionBuffer);
        }
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positionsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        if (this.normalBuffer != null) {
            gl.deleteBuffer(this.normalBuffer);
        }
        this.normalBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, normalsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(1);

        if (this.colorBuffer != null) {
            gl.deleteBuffer(this.colorBuffer);
        }
        this.colorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colorsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(2);

        this.nElements = positionsA.length / 3;//number of vertices

        console.log("chunk created with " + this.nElements + " vertices");

    }

    draw(gl) {
        gl.bindVertexArray(this.vertexArray);
        gl.drawArrays(gl.TRIANGLES, 0, this.nElements);
    }
}