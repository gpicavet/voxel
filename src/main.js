import { mat4, vec3 } from "gl-matrix";
import { Chunk } from './chunk';
import { Terrain } from "./terrain";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');


let camTheta = 0, camPhi = 0;
let camPosition = vec3.fromValues(0, 0, 30);
let keysDown = {};

function onkeydown(event) {
    keysDown[event.key] = true;
}

function onkeyup(event) {
    delete keysDown[event.key];
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


    ///////////////////////////
    // SET UP PROGRAM
    ///////////////////////////

    var vsSource = vshader.trim();
    var vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vsSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        throw new Error((gl.getShaderInfoLog(vertexShader)));
    }

    var fsSource = fshader.trim();
    var fragment = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragment, fsSource);
    gl.compileShader(fragment);

    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
        throw new Error("Vertex shader error : " + gl.getShaderInfoLog(fragment));
    }

    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Fragment shader error : " + gl.getProgramInfoLog(program));
    }

    gl.useProgram(program);


    const terrain = new Terrain(vec3.fromValues(9, 9, 1));
    terrain.init(gl);

    var voxelTextureLocation = gl.getUniformLocation(program, "terrainTex");
    gl.uniform1i(voxelTextureLocation, 0);

    var terrainOffsetLocation = gl.getUniformLocation(program, "terrainOffset");
    gl.uniform3fv(terrainOffsetLocation, vec3.fromValues(
        Chunk.SIZE * Math.floor(terrain.dim[0] / 2),
        Chunk.SIZE * Math.floor(terrain.dim[1] / 2),
        Chunk.SIZE * Math.floor(terrain.dim[2] / 2)));
    var terrainDimLocation = gl.getUniformLocation(program, "terrainDim");
    gl.uniform3fv(terrainDimLocation, vec3.fromValues(
        Chunk.SIZE * terrain.dim[0],
        Chunk.SIZE * terrain.dim[1],
        Chunk.SIZE * terrain.dim[2]));

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
    gl.clearColor(0.8, 0.9, 1.0, 1.0);

    document.getElementById("loading").style.display = 'none';

    function draw() {

        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);

        angle += 0.005;

        if (keysDown["q"] || keysDown["ArrowLeft"]) {
            camTheta += 0.01;
        }
        if (keysDown["d"] || keysDown["ArrowRight"]) {
            camTheta -= 0.01;
        }
        if (keysDown["z"]) {
            camPhi += 0.01;
        }
        if (keysDown["s"]) {
            camPhi -= 0.01;
        }
        var camDir = vec3.fromValues(Math.cos(camTheta) * Math.cos(camPhi), Math.sin(camTheta) * Math.cos(camPhi), Math.sin(camPhi));

        if (keysDown[" "]) {
            const inter = terrain.intersection(camPosition, camDir);
            if (inter) {
                terrain.boom(gl, inter.res.point, 10);
            }
        }


        if (keysDown["ArrowUp"]) {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, 1);
        }
        if (keysDown["ArrowDown"]) {
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


init();