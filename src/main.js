import { mat4, vec3 } from "gl-matrix";
import { moveWithCollisions } from "./collision";
import { Terrain } from "./terrain";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');
var gbufferFshader = require('./gbuffer_fragment.glsl');
var shadowFshader = require('./shadow_fragment.glsl');
var skyVshader = require('./sky_vertex.glsl');
var skyFshader = require('./sky_fragment.glsl');

// per second, so the speed no longer depends on the frame rate (same feel as before at 60 fps)
const MOVE_SPEED = 60;
const TURN_SPEED = 0.6;
const SUN_SPEED = 0.3;
// the camera is a box: it cannot get closer than this to a voxel (keeps the near plane out of the walls)
const CAMERA_HALF_SIZE = vec3.fromValues(0.3, 0.3, 0.3);
// sharper on high density screens, capped because every pixel runs the shadow ray
const MAX_PIXEL_RATIO = 2;

let camTheta = 0, camPhi = 0;
let camPosition = vec3.fromValues(0, 0, 30);
let keysDown = {};
// shadow rays traced at half resolution (4 times fewer rays), or one per pixel
let halfResShadows = true;

function onkeydown(event) {
    keysDown[event.key] = true;
    if (event.key === "h") {
        halfResShadows = !halfResShadows;
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

function createTexture2D(gl, unit, internalFormat, width, height) {
    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
    return texture;
}

function createFramebuffer(gl, color, depth) {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (depth) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Framebuffer incomplete : 0x" + status.toString(16));
    }
    return framebuffer;
}

/**
 * Half resolution render targets of the shadows:
 * - geometry: depth + face direction of the nearest surface (texture units 3 and 4)
 * - mask: shadow, face and plane per half resolution pixel, read by the color pass (texture unit 5)
 */
function createShadowTargets(gl, screenWidth, screenHeight) {
    const width = Math.max(1, Math.ceil(screenWidth / 2));
    const height = Math.max(1, Math.ceil(screenHeight / 2));
    const depth = createTexture2D(gl, gl.TEXTURE3, gl.DEPTH_COMPONENT24, width, height);
    const face = createTexture2D(gl, gl.TEXTURE4, gl.R8, width, height);
    const mask = createTexture2D(gl, gl.TEXTURE5, gl.RGBA8, width, height);
    gl.activeTexture(gl.TEXTURE0);
    return {
        width, height, depth, face, mask,
        geometryFramebuffer: createFramebuffer(gl, face, depth),
        maskFramebuffer: createFramebuffer(gl, mask, null),
    };
}

function deleteShadowTargets(gl, targets) {
    gl.deleteFramebuffer(targets.geometryFramebuffer);
    gl.deleteFramebuffer(targets.maskFramebuffer);
    gl.deleteTexture(targets.depth);
    gl.deleteTexture(targets.face);
    gl.deleteTexture(targets.mask);
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

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vshader);
    const fullscreenVertexShader = compileShader(gl, gl.VERTEX_SHADER, skyVshader);
    const color = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, fshader),
        ["viewProj", "chunkOrigin", "lightDir", "camPosition", "terrainTex", "coarseTex", "midTex", "terrainOffset", "terrainDim",
            "halfResShadows", "shadowMask", "maskScale"]);
    const gbuffer = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, gbufferFshader),
        ["viewProj", "chunkOrigin"]);
    const shadow = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, shadowFshader),
        ["invViewProj", "lightDir", "terrainTex", "coarseTex", "midTex", "terrainOffset", "terrainDim", "halfDepth", "halfFace"]);
    const sky = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, skyFshader),
        ["invViewProj", "camPosition", "lightDir"]);


    const terrain = new Terrain(vec3.fromValues(9, 9, 1));
    terrain.init(gl);

    // texture units: 0, 1, 2 voxel occupancy (fine, coarse, mid), 3 half depth, 4 half face, 5 shadow mask
    for (const program of [color, shadow]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.terrainTex, 0);
        gl.uniform1i(program.locations.coarseTex, 1);
        gl.uniform1i(program.locations.midTex, 2);
        gl.uniform3fv(program.locations.terrainOffset, terrain.offset);
        gl.uniform3fv(program.locations.terrainDim, terrain.size);
    }
    gl.uniform1i(shadow.locations.halfDepth, 3);
    gl.uniform1i(shadow.locations.halfFace, 4);
    gl.useProgram(color.program);
    gl.uniform1i(color.locations.shadowMask, 5);

    var projMatrix = mat4.create();
    var shadowTargets = null;

    function resize() {
        const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        canvas.style.width = window.innerWidth + "px";
        canvas.style.height = window.innerHeight + "px";
        canvas.width = Math.round(window.innerWidth * ratio);
        canvas.height = Math.round(window.innerHeight * ratio);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        mat4.perspective(projMatrix, Math.PI / 4, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 1000.0);
        if (shadowTargets) {
            deleteShadowTargets(gl, shadowTargets);
        }
        shadowTargets = createShadowTargets(gl, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    resize();
    window.addEventListener('resize', resize);

    var viewMatrix = mat4.create();
    var viewProjMatrix = mat4.create();
    var invViewProjMatrix = mat4.create();
    var rotateZMatrix = mat4.create();
    var camDir = vec3.create();
    var camAt = vec3.create();
    var lightDir = vec3.create();
    var move = vec3.create();

    var angle = 0.0;
    var lastTime = performance.now();

    const gpuTimer = createGpuTimer(gl);
    const statsElement = document.getElementById("stats");
    let frames = 0, statsTime = performance.now(), visibleChunks = 0, facesDrawn = 0;


    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.0, 0.0, 0.0, 0.0); // 0 = no face in the half resolution face texture; the sky covers the screen

    document.getElementById("loading").style.display = 'none';

    function draw() {

        gpuTimer.begin();

        const time = performance.now();
        // capped so that a long pause (tab in the background) does not make a huge jump
        const dt = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;

        angle += SUN_SPEED * dt;

        if (keysDown["q"] || keysDown["ArrowLeft"]) {
            camTheta += TURN_SPEED * dt;
        }
        if (keysDown["d"] || keysDown["ArrowRight"]) {
            camTheta -= TURN_SPEED * dt;
        }
        if (keysDown["z"]) {
            camPhi += TURN_SPEED * dt;
        }
        if (keysDown["s"]) {
            camPhi -= TURN_SPEED * dt;
        }
        camPhi = Math.max(-1.55, Math.min(1.55, camPhi)); // lookAt breaks when looking straight up or down
        vec3.set(camDir, Math.cos(camTheta) * Math.cos(camPhi), Math.sin(camTheta) * Math.cos(camPhi), Math.sin(camPhi));

        if (keysDown[" "]) {
            const inter = terrain.intersection(camPosition, camDir);
            if (inter) {
                terrain.boom(gl, inter.point, 10);
            }
        }


        const forward = (keysDown["ArrowUp"] ? 1 : 0) - (keysDown["ArrowDown"] ? 1 : 0);
        if (forward !== 0) {
            vec3.scale(move, camDir, forward * MOVE_SPEED * dt);
            moveWithCollisions(terrain, camPosition, move, CAMERA_HALF_SIZE);
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

        mat4.invert(invViewProjMatrix, viewProjMatrix);

        const visible = terrain.cull(viewProjMatrix, camPosition);
        visibleChunks = visible.length;

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);

        if (halfResShadows) {
            // 1. half resolution: depth and face direction of the nearest surface (cheap fragment shader)
            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTargets.geometryFramebuffer);
            gl.viewport(0, 0, shadowTargets.width, shadowTargets.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(gbuffer.program);
            gl.uniformMatrix4fv(gbuffer.locations.viewProj, false, viewProjMatrix);
            terrain.draw(gl, visible, camPosition, gbuffer.locations.chunkOrigin);

            // 2. one shadow ray per half resolution pixel, exactly once whatever the overdraw
            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTargets.maskFramebuffer);
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(shadow.program);
            gl.uniformMatrix4fv(shadow.locations.invViewProj, false, invViewProjMatrix);
            gl.uniform3fv(shadow.locations.lightDir, lightDir);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        // 3. full resolution color, shadows read from the mask (or traced per pixel)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(color.program);
        gl.uniformMatrix4fv(color.locations.viewProj, false, viewProjMatrix);
        gl.uniform3fv(color.locations.lightDir, lightDir);
        gl.uniform3fv(color.locations.camPosition, camPosition);
        gl.uniform1i(color.locations.halfResShadows, halfResShadows ? 1 : 0);
        gl.uniform2f(color.locations.maskScale,
            shadowTargets.width / gl.drawingBufferWidth, shadowTargets.height / gl.drawingBufferHeight);
        facesDrawn = terrain.draw(gl, visible, camPosition, color.locations.chunkOrigin);

        // 4. sky last, on the far plane: only the pixels the terrain left empty are shaded
        gl.useProgram(sky.program);
        gl.uniformMatrix4fv(sky.locations.invViewProj, false, invViewProjMatrix);
        gl.uniform3fv(sky.locations.camPosition, camPosition);
        gl.uniform3fv(sky.locations.lightDir, lightDir);
        gl.depthMask(false);
        gl.depthFunc(gl.LEQUAL);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

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
                ` | ${canvas.width}x${canvas.height}` +
                ` | pos ${Array.from(camPosition, v => v.toFixed(1)).join(" ")}` +
                ` | shadows ${halfResShadows ? "half" : "full"} res (h)`;
            frames = 0;
            statsTime = now;
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}


init();
