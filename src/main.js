import alea from 'alea';
import { mat4, vec3 } from "gl-matrix";
import { createNoise3D } from "simplex-noise";
import { intersection } from './utils';
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');

const CHUNK_SIZE_POW = 6;//size = 64
const CHUNK_SIZE = 1 << CHUNK_SIZE_POW;

let camTheta = -2.7, camPhi = -0.7;
let camPosition = vec3.fromValues(200, 200, 200);
let keyDown = null;

function onkeydown(event) {
    keyDown = event.key;
}

function onkeyup(event) {
    keyDown = null;
}

function init() {

    var canvas = document.getElementById("gl-canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.addEventListener('keydown', onkeydown, false);
    document.addEventListener('keyup', onkeyup, false);

    var gl = canvas.getContext("webgl2");
    if (!gl) {
        console.error("WebGL 2 not available");
        document.body.innerHTML = "This example requires WebGL 2 which is unavailable on this system."
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    ///////////////////////////
    // SET UP PROGRAM
    ///////////////////////////

    var vsSource = vshader.trim();
    var vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vsSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(vertexShader));
    }

    var fsSource = fshader.trim();
    var fragment = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragment, fsSource);
    gl.compileShader(fragment);

    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(fragment));
    }

    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
    }

    gl.useProgram(program);


    const terrain = new Terrain(vec3.fromValues(9, 9, 1));
    terrain.init(gl);

    var voxelTextureLocation = gl.getUniformLocation(program, "terrainTex");
    gl.uniform1i(voxelTextureLocation, 0);

    var terrainOffsetLocation = gl.getUniformLocation(program, "terrainOffset");
    gl.uniform3fv(terrainOffsetLocation, vec3.fromValues(
        CHUNK_SIZE * Math.floor(terrain.dim[0] / 2),
        CHUNK_SIZE * Math.floor(terrain.dim[1] / 2),
        CHUNK_SIZE * Math.floor(terrain.dim[2] / 2)));
    var terrainDimLocation = gl.getUniformLocation(program, "terrainDim");
    gl.uniform3fv(terrainDimLocation, vec3.fromValues(
        CHUNK_SIZE * terrain.dim[0],
        CHUNK_SIZE * terrain.dim[1],
        CHUNK_SIZE * terrain.dim[2]));

    var projMatrix = mat4.create();
    mat4.perspective(projMatrix, Math.PI / 4, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 1000.0);

    var lightDirLocation = gl.getUniformLocation(program, "lightDir");



    var viewMatrix = mat4.create();
    var viewProjMatrix = mat4.create();
    var rotateZMatrix = mat4.create();

    var angle = 0.0;

    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    var timer = Date.now();


    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    document.getElementById("loading").style.display = 'none';

    function draw() {

        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);

        angle += 0.005;

        if (keyDown == "q" || keyDown == "ArrowLeft") {
            camTheta += 0.01;
        }
        if (keyDown == "d" || keyDown == "ArrowRight") {
            camTheta -= 0.01;
        }
        if (keyDown == "z") {
            camPhi += 0.01;
        }
        if (keyDown == "s") {
            camPhi -= 0.01;
        }
        var camDir = vec3.fromValues(Math.cos(camTheta) * Math.cos(camPhi), Math.sin(camTheta) * Math.cos(camPhi), Math.sin(camPhi));

        if (keyDown == " ") {
            const inter = terrain.intersection(camPosition, camDir);
            if (inter) {
                const res = inter.chunk.boom(inter.res.point, 10);
                if (res) {
                    inter.chunk.createArray(gl);
                    terrain.updateTexture([inter.chunk], gl);
                }
            }
        }


        if (keyDown == "ArrowUp") {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, 1);
        }
        if (keyDown == "ArrowDown") {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, -1);
        }

        var camAt = vec3.create();
        camAt = vec3.add(camAt, camPosition, camDir);

        mat4.lookAt(viewMatrix, camPosition,
            camAt,
            vec3.fromValues(0, 0, 1));
        mat4.multiply(viewProjMatrix, projMatrix, viewMatrix);

        var viewProjLocation = gl.getUniformLocation(program, "viewProj");
        gl.uniformMatrix4fv(viewProjLocation, false, viewProjMatrix);


        mat4.fromZRotation(rotateZMatrix, angle);
        var lightDir = vec3.fromValues(-1, -1, -1);
        lightDir = vec3.normalize(lightDir, lightDir);
        vec3.transformMat4(lightDir, lightDir, rotateZMatrix);

        gl.uniform3fv(lightDirLocation, lightDir);

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        terrain.draw(gl, camPosition);

        gl.endQuery(ext.TIME_ELAPSED_EXT);

        if (Date.now() - timer > 1000) {

            setTimeout(() => {
                const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
                if (available) {
                    timer = Date.now();
                    const elapsedNanos = gl.getQueryParameter(query, gl.QUERY_RESULT);
                    //console.log("rendering time", elapsedNanos / 1000000);
                }
            }, 100);
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}

class Terrain {
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
                    const chunk = new Chunk(CHUNK_SIZE_POW,
                        vec3.fromValues((x - cx) << CHUNK_SIZE_POW, (y - cy) << CHUNK_SIZE_POW, (z - cz) << CHUNK_SIZE_POW));
                    chunk.init(noise3D);
                    chunk.createArray(gl);
                    this.chunks[x][y][z] = chunk;
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

        const terrainData = new Uint8Array(this.dim[0] * CHUNK_SIZE * this.dim[1] * CHUNK_SIZE * this.dim[2] * CHUNK_SIZE);
        var offs = 0;

        // Charger les données du terrain dans la texture 3D
        for (var z = 0; z < this.dim[2] * CHUNK_SIZE; z++) {
            for (var y = 0; y < this.dim[1] * CHUNK_SIZE; y++) {
                for (var x = 0; x < this.dim[0] * CHUNK_SIZE; x++) {
                    const cz = (z >> CHUNK_SIZE_POW);
                    const cy = (y >> CHUNK_SIZE_POW);
                    const cx = (x >> CHUNK_SIZE_POW);
                    const vx = x & (CHUNK_SIZE - 1);
                    const vy = y & (CHUNK_SIZE - 1);
                    const vz = z & (CHUNK_SIZE - 1);
                    terrainData[offs++] = this.chunks[cx][cy][cz].getVoxel(vx, vy, vz);
                }
            }
        }

        gl.texImage3D(gl.TEXTURE_3D, 0,
            gl.R8UI,
            this.dim[0] * CHUNK_SIZE, this.dim[1] * CHUNK_SIZE, this.dim[2] * CHUNK_SIZE,
            0, gl.RED_INTEGER, gl.UNSIGNED_BYTE,
            terrainData);
    }

    updateTexture(chunks, gl) {
        console.log("updating 3D texture")

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, this.voxelTexture);


        // Charger les données du terrain dans la texture 3D
        for (var chunk of chunks) {
            const terrainData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
            var offs = 0;

            for (var z = 0; z < CHUNK_SIZE; z++) {
                for (var y = 0; y < CHUNK_SIZE; y++) {
                    for (var x = 0; x < CHUNK_SIZE; x++) {
                        terrainData[offs++] = chunk.getVoxel(x, y, z);
                    }
                }
            }
            gl.texSubImage3D(gl.TEXTURE_3D, 0,
                chunk.pos[0] + Math.floor(this.dim[0] / 2) * CHUNK_SIZE, chunk.pos[1] + Math.floor(this.dim[1] / 2) * CHUNK_SIZE, chunk.pos[2],
                CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE,
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
                    const res = chunk.boxIntersection(from, dir);
                    //console.log(chunk.pos[0], chunk.pos[1], chunk.pos[2], " : ", res[0], res[1], res[2]);
                    if (res.dist !== Infinity) {
                        chunksSortedByDist.push({ chunk, res });
                    }
                }
            }
        }
        chunksSortedByDist.sort((c1, c2) => c1.res.dist - c2.res.dist);
        console.log(chunksSortedByDist.length);

        for (var chunk of chunksSortedByDist) {
            const res = chunk.chunk.voxelIntersection(from, dir);
            if (res) {
                return { chunk: chunk.chunk, res };
            }
        }

        return null;
    }

    draw(gl, camPosition) {
        //we render chunk from the nearest to the farthest, so we better use the depth buffer to limit fragment shader useless overdraw
        //TODO: dont render chunks outside camera frustrum
        var chunkSortedByDist = [];
        for (var x = 0; x < 9; x++) {
            for (var y = 0; y < 9; y++) {
                for (var z = 0; z < 1; z++) {
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

class Chunk {

    constructor(dimPow, pos) {
        this.dimPow = dimPow
        this.dim = 1 << dimPow;
        this.pos = pos;
        this.voxels = new Array(this.dim * this.dim * this.dim);
        this.vertexArray = null;
        this.positionBuffer = null;
        this.normalBuffer = null;
        this.colorBuffer = null;
        this.nElements = 0;
    }

    center() {
        return vec3.fromValues(this.pos[0] + this.dim / 2, this.pos[1] + this.dim / 2, this.pos[2] + this.dim / 2);
    }

    setVoxel(x, y, z, val) {
        this.voxels[(((x << this.dimPow) + y) << this.dimPow) + z] = val;
    }
    getVoxel(x, y, z) {
        return this.voxels[(((x << this.dimPow) + y) << this.dimPow) + z];
    }

    init(noise) {

        for (var x = 0; x < this.dim; x++) {
            for (var y = 0; y < this.dim; y++) {
                for (var z = 0; z < this.dim; z++) {
                    var dens = (noise((this.pos[0] + x) * 0.01,
                        (this.pos[1] + y) * 0.01,
                        (this.pos[2] + z) * 0.01));

                    this.setVoxel(x, y, z, 0);
                    if (z + this.pos[2] == 0 || dens < -0.4) {
                        this.setVoxel(x, y, z, 1);
                    }
                }
            }
        }

    }


    boxIntersection(from, dir) {
        var res = vec3.create();
        var aabb = [
            [this.pos[0], this.pos[1], this.pos[2]],
            [this.pos[0] + this.dim, this.pos[1] + this.dim, this.pos[2] + this.dim],
        ];

        var inside = true;
        for (var i = 0; i < 3; i++)
            if (aabb[0][i] < from[i] || from[i] > aabb[1][i]) {
                inside = false;
                break;
            }

        if (inside) {
            res = { dist: 0, point: null };
        } else {
            res = intersection(res, from, dir, aabb);
        }
        return res;
    }

    voxelIntersection(from, dir) {
        var minInter = null;
        for (var x = 0; x < this.dim; x++) {
            for (var y = 0; y < this.dim; y++) {
                for (var z = 0; z < this.dim; z++) {
                    if (this.getVoxel(x, y, z) > 0) {
                        var min = [this.pos[0] + x, this.pos[1] + y, this.pos[2] + z];
                        var max = [min[0] + 1, min[1] + 1, min[2] + 1];
                        var aabb = [
                            min, max
                        ];

                        var inside = true;
                        for (var i = 0; i < 3; i++)
                            if (aabb[0][i] < from[i] || from[i] > aabb[1][i]) {
                                inside = false;
                                break;
                            }

                        if (inside) {
                            var del = [min[0] + 0.5 - from[0], min[1] + 0.5 - from[1], min[2] + 0.5 - from[2]];
                            return [Math.sqrt(del[0] * del[0] + del[1] * del[1] + del[2] * del[2]), min];
                        } else {
                            var res = intersection([0, 0, 0], from, dir, aabb);
                            if (res.dist !== Infinity) {
                                if (minInter == null || minInter.dist > res.dist) {
                                    minInter = res;
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

        for (var x = 0; x < this.dim; x++) {
            for (var y = 0; y < this.dim; y++) {
                for (var z = 0; z < this.dim; z++) {
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

        for (var x = 0; x < this.dim; x++) {
            for (var y = 0; y < this.dim; y++) {
                for (var z = 0; z < this.dim; z++) {

                    if (this.getVoxel(x, y, z) > 0) {

                        const visibleFace = [];
                        visibleFace[0] = (x >= this.dim - 1 || this.getVoxel(x + 1, y, z) == 0);
                        visibleFace[1] = (x <= 0 || this.getVoxel(x - 1, y, z) == 0);
                        visibleFace[2] = (y >= this.dim - 1 || this.getVoxel(x, y + 1, z) == 0);
                        visibleFace[3] = (y <= 0 || this.getVoxel(x, y - 1, z) == 0);
                        visibleFace[4] = (z >= this.dim - 1 || this.getVoxel(x, y, z + 1) == 0);
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
                            if (zz >= this.dim - 1 || this.getVoxel(x, y, zz) == 0) {
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
                                return (dx == 0 || (dx < 0 && x > 0) || (dx > 0 && x < this.dim - 1)) &&
                                    (dy == 0 || (dy < 0 && y > 0) || (dy > 0 && y < this.dim - 1)) &&
                                    (dz == 0 || (dz < 0 && z > 0) || (dz > 0 && z < this.dim - 1)) &&
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




init();