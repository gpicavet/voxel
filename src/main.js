import alea from 'alea';
import { mat4, vec3 } from "gl-matrix";
import { createNoise3D } from "simplex-noise";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');

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



    const noise3D = createNoise3D(alea('0'));

    const chunks = new Array(9);

    for (var x = -4; x <= 4; x++) {
        chunks[x + 4] = new Array(9);
        for (var y = -4; y <= 4; y++) {
            chunks[x + 4][y + 4] = new Array(1);
            for (var z = 0; z <= 0; z++) {
                const chunk = new Chunk(vec3.fromValues(64, 64, 64), vec3.fromValues(64 * x, 64 * y, 64 * z));
                chunk.init(noise3D);
                chunk.createArray(gl);
                chunks[x + 4][y + 4][z] = chunk;
            }
        }
    }

    console.log("generate 3D texture")
    gl.activeTexture(gl.TEXTURE0);
    var voxelTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, voxelTexture);

    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    var terrainData = new Uint8Array(9 * 64 * 9 * 64 * 64);
    var offs = 0;


    // Charger les données du terrain dans la texture 3D
    for (var z = 0; z < 64; z++) {
        for (var y = 0; y < 9 * 64; y++) {
            for (var x = 0; x < 9 * 64; x++) {
                var cz = 0;
                var cy = Math.floor(y / 64);
                var cx = Math.floor(x / 64);
                terrainData[offs++] = chunks[cx][cy][cz].voxels[x % 64][y % 64][z];
            }
        }
    }

    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, 9 * 64, 9 * 64, 64, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, terrainData);

    var voxelTextureLocation = gl.getUniformLocation(program, "terrainTex");
    gl.uniform1i(voxelTextureLocation, 0);

    var terrainOffsetLocation = gl.getUniformLocation(program, "terrainOffset");
    gl.uniform3fv(terrainOffsetLocation, vec3.fromValues(64 * Math.floor(chunks.length / 2), 64 * Math.floor(chunks.length / 2), 0));
    var terrainDimLocation = gl.getUniformLocation(program, "terrainDim");
    gl.uniform3fv(terrainDimLocation, vec3.fromValues(64 * chunks.length, 64 * chunks.length, 64));

    console.log(terrainData.length);

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

    //document.getElementById("loading").display = 'none';

    function draw() {

        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);

        angle += 0.005;

        if (keyDown == "q") {
            camTheta += 0.01;
        }
        if (keyDown == "d") {
            camTheta -= 0.01;
        }
        if (keyDown == "z") {
            camPhi += 0.01;
        }
        if (keyDown == "s") {
            camPhi -= 0.01;
        }

        var camDir = vec3.fromValues(Math.cos(camTheta) * Math.cos(camPhi), Math.sin(camTheta) * Math.cos(camPhi), Math.sin(camPhi));

        if (keyDown == "ArrowUp") {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, 0.5);
        }
        if (keyDown == "ArrowDown") {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, -0.5);
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

        for (var x = -4; x <= 4; x++) {
            for (var y = -4; y <= 4; y++) {
                for (var z = 0; z <= 0; z++) {
                    chunks[x + 4][y + 4][z].draw(gl);
                }
            }
        }

        gl.endQuery(ext.TIME_ELAPSED_EXT);

        if (Date.now() - timer > 1000) {
            setTimeout(() => {
                const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
                if (available) {
                    timer = Date.now();
                    const elapsedNanos = gl.getQueryParameter(query, gl.QUERY_RESULT);
                    console.log("rendering time", elapsedNanos / 1000000);
                }
            }, 10);
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}

class Chunk {

    constructor(dim, pos) {
        this.dim = dim;
        this.pos = pos;
        this.voxels = new Array(this.dim[0]);
        this.vertexArray = null;
        this.nElements = 0;
    }

    init(noise) {

        var offs = 0;
        this.voxels = new Array(this.dim[0]);
        for (var x = 0; x < this.dim[0]; x++) {
            this.voxels[x] = new Array(this.dim[1]);
            for (var y = 0; y < this.dim[1]; y++) {
                this.voxels[x][y] = new Array(this.dim[2]);
                for (var z = 0; z < this.dim[2]; z++) {
                    var dens = (noise((this.pos[0] + x) * 0.01, (this.pos[1] + y) * 0.01, (this.pos[2] + z) * 0.01));

                    this.voxels[x][y][z] = 0;
                    if (z + this.pos[2] == 0 || dens < -0.4) {
                        this.voxels[x][y][z] = 1;
                    }

                    offs++;
                }
            }
        }

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

        for (var x = 0; x < this.dim[0]; x++) {
            for (var y = 0; y < this.dim[1]; y++) {
                for (var z = 0; z < this.dim[2]; z++) {

                    if (this.voxels[x][y][z] > 0) {

                        const visibleFace = [];
                        visibleFace[0] = (x >= this.dim[0] - 1 || this.voxels[x + 1][y][z] == 0);
                        visibleFace[1] = (x <= 0 || this.voxels[x - 1][y][z] == 0);
                        visibleFace[2] = (y >= this.dim[1] - 1 || this.voxels[x][y + 1][z] == 0);
                        visibleFace[3] = (y <= 0 || this.voxels[x][y - 1][z] == 0);
                        visibleFace[4] = (z >= this.dim[2] - 1 || this.voxels[x][y][z + 1] == 0);
                        visibleFace[5] = (z <= 0 || this.voxels[x][y][z - 1] == 0);

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
                            if (zz >= this.dim[2] - 1 || this.voxels[x][y][zz] == 0) {
                                color = colorGrass;
                            }

                            //culling
                            //only create triangles indices for not shared faces (visible face)
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
                                return (dx == 0 || (dx < 0 && x > 0) || (dx > 0 && x < this.dim[0] - 1)) &&
                                    (dy == 0 || (dy < 0 && y > 0) || (dy > 0 && y < this.dim[1] - 1)) &&
                                    (dz == 0 || (dz < 0 && z > 0) || (dz > 0 && z < this.dim[2] - 1)) &&
                                    this.voxels[x + dx][y + dy][z + dz] > 0;
                            }

                            for (var f = 0; f < 6; f++) {
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

                                        //ambient occlusion
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

        console.log(positions.length / 3);


        var positionsA = new Float32Array(positions);
        var normalsA = new Float32Array(normals);
        var colorsA = new Float32Array(colors);

        this.vertexArray = gl.createVertexArray();
        gl.bindVertexArray(this.vertexArray);

        var positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positionsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        var normalBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, normalsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(1);

        var colorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colorsA, gl.STATIC_DRAW);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(2);

        this.nElements = positionsA.length / 3;//number of vertices

    }

    draw(gl) {
        gl.bindVertexArray(this.vertexArray);
        gl.drawArrays(gl.TRIANGLES, 0, this.nElements);
    }
}




init();