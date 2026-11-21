import { mat4, vec3 } from "gl-matrix";
import { Terrain } from "./terrain";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');
var depthFshader = require('./depth_fragment.glsl');


let camTheta = 0, camPhi = 0;
let camPosition = vec3.fromValues(0, 0, 30);
let keysDown = {};
// Off by default: with the cheap shadow rays and the front to back order, the pre-pass costs more
// vertex work than it saves (5-15 % slower on an M3 Pro). Worth it again if the fragment shader gets heavier.
let depthPrepass = false;

function onkeydown(event) {
    keysDown[event.key] = true;
    if (event.key === "p") {
        depthPrepass = !depthPrepass;
    }
}

function onkeyup(event) {
    delete keysDown[event.key];
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source.trim());
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error((type === gl.VERTEX_SHADER ? "Vertex" : "Fragment") + " shader error : " + gl.getShaderInfoLog(shader));
    }
    return shader;
}

function createProgram(gl, vertexShader, fragmentShader, uniforms) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error("Program link error : " + gl.getProgramInfoLog(program));
    }
    const locations = {};
    for (const name of uniforms) {
        locations[name] = gl.getUniformLocation(program, name);
    }
    return { program, locations };
}

/** GPU time of a frame, when EXT_disjoint_timer_query_webgl2 is available (not on Firefox and Safari) */
function createGpuTimer(gl) {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let query = null;
    let samples = 0, total = 0;
    return {
        begin() {
            if (!ext) return;
            // one query in flight: read the previous one first
            if (query) {
                if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
                if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
                    total += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
                    samples++;
                }
                gl.deleteQuery(query);
                query = null;
            }
            query = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
            this.running = true;
        },
        end() {
            if (this.running) {
                gl.endQuery(ext.TIME_ELAPSED_EXT);
                this.running = false;
            }
        },
        /** average since the last call, in ms, or null */
        take() {
            if (samples === 0) return null;
            const avg = total / samples;
            total = 0; samples = 0;
            return avg;
        },
        running: false,
    };
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
        return;
    }


    ///////////////////////////
    // SET UP PROGRAMS
    ///////////////////////////

    // the same vertex shader in both programs, so the depth values match
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vshader);
    const color = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, fshader),
        ["viewProj", "chunkOrigin", "lightDir", "terrainTex", "coarseTex", "terrainOffset", "terrainDim"]);
    const depth = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, depthFshader),
        ["viewProj", "chunkOrigin"]);


    const terrain = new Terrain(vec3.fromValues(9, 9, 1));
    terrain.init(gl);

    gl.useProgram(color.program);
    gl.uniform1i(color.locations.terrainTex, 0);
    gl.uniform1i(color.locations.coarseTex, 1);
    gl.uniform3fv(color.locations.terrainOffset, terrain.offset);
    gl.uniform3fv(color.locations.terrainDim, terrain.size);

    var projMatrix = mat4.create();
    mat4.perspective(projMatrix, Math.PI / 4, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 1000.0);

    var viewMatrix = mat4.create();
    var viewProjMatrix = mat4.create();
    var rotateZMatrix = mat4.create();
    var camDir = vec3.create();
    var camAt = vec3.create();
    var lightDir = vec3.create();

    var angle = 0.0;

    const gpuTimer = createGpuTimer(gl);
    const statsElement = document.getElementById("stats");
    let frames = 0, statsTime = performance.now(), visibleChunks = 0, facesDrawn = 0;


    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.8, 0.9, 1.0, 1.0);

    document.getElementById("loading").style.display = 'none';

    function draw() {

        gpuTimer.begin();

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
        vec3.set(camDir, Math.cos(camTheta) * Math.cos(camPhi), Math.sin(camTheta) * Math.cos(camPhi), Math.sin(camPhi));

        if (keysDown[" "]) {
            const inter = terrain.intersection(camPosition, camDir);
            if (inter) {
                terrain.boom(gl, inter.point, 10);
            }
        }


        if (keysDown["ArrowUp"]) {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, 1);
        }
        if (keysDown["ArrowDown"]) {
            vec3.scaleAndAdd(camPosition, camPosition, camDir, -1);
        }

        vec3.add(camAt, camPosition, camDir);

        mat4.lookAt(viewMatrix, camPosition,
            camAt,
            vec3.fromValues(0, 0, 1));
        mat4.multiply(viewProjMatrix, projMatrix, viewMatrix);

        mat4.fromZRotation(rotateZMatrix, angle);
        vec3.set(lightDir, -1, -1, -1);
        vec3.normalize(lightDir, lightDir);
        vec3.transformMat4(lightDir, lightDir, rotateZMatrix);

        const visible = terrain.cull(viewProjMatrix, camPosition);
        visibleChunks = visible.length;

        gl.depthMask(true);
        gl.colorMask(true, true, true, true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (depthPrepass) {
            // 1. depth only: after this pass the depth buffer holds the nearest surface of every pixel
            gl.useProgram(depth.program);
            gl.uniformMatrix4fv(depth.locations.viewProj, false, viewProjMatrix);
            gl.colorMask(false, false, false, false);
            gl.depthFunc(gl.LESS);
            terrain.draw(gl, visible, camPosition, depth.locations.chunkOrigin);

            // 2. the expensive fragment shader then runs once per pixel, whatever the overdraw
            gl.colorMask(true, true, true, true);
            gl.depthMask(false);
            gl.depthFunc(gl.LEQUAL);
        } else {
            gl.depthFunc(gl.LESS);
        }

        gl.useProgram(color.program);
        gl.uniformMatrix4fv(color.locations.viewProj, false, viewProjMatrix);
        gl.uniform3fv(color.locations.lightDir, lightDir);
        facesDrawn = terrain.draw(gl, visible, camPosition, color.locations.chunkOrigin);

        gpuTimer.end();

        frames++;
        const now = performance.now();
        if (now - statsTime > 500) {
            const gpuMs = gpuTimer.take();
            statsElement.textContent =
                `${(frames * 1000 / (now - statsTime)).toFixed(0)} fps` +
                (gpuMs !== null ? ` | GPU ${gpuMs.toFixed(2)} ms` : "") +
                ` | chunks ${visibleChunks}/${terrain.chunks.length}` +
                ` | ${(facesDrawn * 2 / 1e6).toFixed(2)} M triangles` +
                ` | depth pre-pass ${depthPrepass ? "on" : "off"} (p)`;
            frames = 0;
            statsTime = now;
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}


init();
