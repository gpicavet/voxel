import { mat4, vec3 } from "gl-matrix";
import { moveWithCollisions } from "./collision";
import { CHUNK_SIZE } from "./constants";
import { clockTime, createDaylight, daylight } from "./daylight";
import { World } from "./world";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');
var gbufferFshader = require('./gbuffer_fragment.glsl');
var shadowFshader = require('./shadow_fragment.glsl');
var skyVshader = require('./sky_vertex.glsl');
var skyFshader = require('./sky_fragment.glsl');
var skyLutFshader = require('./sky_lut_fragment.glsl');

// per second, so the speed no longer depends on the frame rate (same feel as before at 60 fps)
const MOVE_SPEED = 60;
const TURN_SPEED = 0.6;
const SUN_SPEED = 0.003; // rad/s of hour angle (a day in 35 min); slow: the shadows of the previous frames stay valid
const FAST_TIME = 200;    // time speed while t is held
const SKY_LUT_SIZE = [256, 128];
// the camera is a box: it cannot get closer than this to a voxel (keeps the near plane out of the walls)
const CAMERA_HALF_SIZE = vec3.fromValues(0.3, 0.3, 0.3);
// sharper on high density screens, capped because every pixel runs the shadow ray
const MAX_PIXEL_RATIO = 2;
// uniforms of common.glsl
const SKY_UNIFORMS = ["skyLUT", "sunDir", "lightDir", "lightColor", "exposure"];
// uniforms of shadow.glsl
const SHADOW_UNIFORMS = ["brickTex", "coarseTex", "windowMin", "windowSize", "brickOrigin", "coarseOrigin"];

let camTheta = 0, camPhi = -0.35; // looking a bit down
let camPosition = vec3.create();
let keysDown = {};
// shadow rays traced at half resolution (4 times fewer rays), or one per pixel
let halfResShadows = true;
let viewRadiusChange = 0;
let caveCullingToggle = false;
let maskHistoryStale = false;

function onkeydown(event) {
    keysDown[event.key] = true;
    if (event.key === "h") {
        halfResShadows = !halfResShadows;
        maskHistoryStale = true;
    }
    if (event.key === "c") {
        caveCullingToggle = true;
    }
    if (event.key === "+" || event.key === "=") {
        viewRadiusChange = 1;
    }
    if (event.key === "-") {
        viewRadiusChange = -1;
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
    // two masks: one is written while the other (previous frame) is read, then they swap
    const masks = [createTexture2D(gl, gl.TEXTURE5, gl.RGBA8, width, height), createTexture2D(gl, gl.TEXTURE6, gl.RGBA8, width, height)];
    gl.activeTexture(gl.TEXTURE0);
    return {
        width, height, depth, face, masks,
        current: 0, // index of the mask written this frame
        historyValid: false,
        geometryFramebuffer: createFramebuffer(gl, face, depth),
        maskFramebuffers: masks.map(mask => createFramebuffer(gl, mask, null)),
    };
}

function deleteShadowTargets(gl, targets) {
    gl.deleteFramebuffer(targets.geometryFramebuffer);
    targets.maskFramebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
    gl.deleteTexture(targets.depth);
    gl.deleteTexture(targets.face);
    targets.masks.forEach(mask => gl.deleteTexture(mask));
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
        ["viewProj", "chunkOrigin", "camPosition", "halfResShadows", "shadowMask", "maskScale", "halfDepth", "depthRange", "fogDensity", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS]);
    const gbuffer = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, gbufferFshader),
        ["viewProj", "chunkOrigin"]);
    const shadow = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, shadowFshader),
        ["invViewProj", "lightDir", "halfDepth", "halfFace", "historyMask", "prevViewProj", "frameIndex", "refreshAll", ...SHADOW_UNIFORMS]);
    const sky = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, skyFshader),
        ["invViewProj", "camPosition", "moonDir", "sunDiskColor", "moonDiskColor", "starVisibility", ...SKY_UNIFORMS]);
    const skyLut = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, skyLutFshader),
        ["sunDir", "moonDir", "moonSky", "lutSize"]);

    // sky radiance texture (unit 7): half floats when they can be rendered to
    const floatTargets = !!gl.getExtension("EXT_color_buffer_float");
    gl.activeTexture(gl.TEXTURE7);
    const skyLutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, skyLutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // azimuth
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, floatTargets ? gl.RGBA16F : gl.RGBA8, SKY_LUT_SIZE[0], SKY_LUT_SIZE[1]);
    gl.activeTexture(gl.TEXTURE0);
    const skyLutFramebuffer = createFramebuffer(gl, skyLutTexture, null);
    let skyLutAngle = null;


    const world = new World(gl);
    // start above the ground at the center of the world
    vec3.set(camPosition, 0.5, 0.5, world.surfaceHeight(0, 0) + 25);

    // texture units: 0 voxel bricks, 1 coarse occupancy (shadow window), 3 half depth, 4 half face, 5 and 6 shadow masks
    for (const program of [color, shadow]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.brickTex, 0);
        gl.uniform1i(program.locations.coarseTex, 1);
    }
    for (const program of [color, sky]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.skyLUT, 7);
    }
    gl.useProgram(color.program);
    gl.uniform1i(color.locations.halfDepth, 3);
    gl.useProgram(shadow.program);
    gl.uniform1i(shadow.locations.halfDepth, 3);
    gl.uniform1i(shadow.locations.halfFace, 4);

    var projMatrix = mat4.create();
    var shadowTargets = null;

    // the far plane and the fog follow the view distance: chunks appear in the fog, not at a visible edge
    function viewDistance() {
        return (world.viewRadius - 0.5) * CHUNK_SIZE;
    }
    const NEAR = 0.1;
    function farPlane() {
        return viewDistance() * 1.5;
    }
    function updateProjection() {
        mat4.perspective(projMatrix, Math.PI / 4, gl.drawingBufferWidth / gl.drawingBufferHeight, NEAR, farPlane());
    }

    function resize() {
        const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        canvas.style.width = window.innerWidth + "px";
        canvas.style.height = window.innerHeight + "px";
        canvas.width = Math.round(window.innerWidth * ratio);
        canvas.height = Math.round(window.innerHeight * ratio);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        updateProjection();
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
    var prevViewProjMatrix = mat4.create();
    var frameIndex = 0;
    var camDir = vec3.create();
    var camAt = vec3.create();
    var move = vec3.create();

    var hourAngle = -1.0; // about 8 in the morning
    var light = createDaylight();
    var wasNight = null;
    var lastTime = performance.now();

    function setSky(program) {
        gl.uniform3fv(program.locations.sunDir, light.sunDir);
        gl.uniform3fv(program.locations.lightDir, light.lightDir);
        gl.uniform3fv(program.locations.lightColor, light.lightColor);
        gl.uniform1f(program.locations.exposure, light.exposure);
    }

    function setShadowWindow(program) {
        gl.uniform3fv(program.locations.windowMin, world.windowMin);
        gl.uniform3fv(program.locations.windowSize, world.windowSize);
        gl.uniform3iv(program.locations.brickOrigin, world.brickOrigin);
        gl.uniform3iv(program.locations.coarseOrigin, world.coarseOrigin);
    }

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

        const timeScale = keysDown["t"] ? FAST_TIME : 1;
        hourAngle += SUN_SPEED * dt * timeScale;
        daylight(light, hourAngle);
        const night = light.sunDir[2] < -0.05; // the moon is the main light (see daylight.js)
        // shadows of the previous frames are wrong when time runs fast, or when the moon takes over
        if (timeScale > 1 || night !== wasNight) {
            maskHistoryStale = true;
        }
        wasNight = night;

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
            const inter = world.intersection(camPosition, camDir);
            if (inter) {
                world.boom(inter.point, 10);
            }
        }


        const forward = (keysDown["ArrowUp"] ? 1 : 0) - (keysDown["ArrowDown"] ? 1 : 0);
        if (forward !== 0) {
            vec3.scale(move, camDir, forward * MOVE_SPEED * dt);
            moveWithCollisions(world, camPosition, move, CAMERA_HALF_SIZE);
        }

        vec3.add(camAt, camPosition, camDir);

        mat4.lookAt(viewMatrix, camPosition,
            camAt,
            vec3.fromValues(0, 0, 1));
        mat4.multiply(viewProjMatrix, projMatrix, viewMatrix);

        mat4.invert(invViewProjMatrix, viewProjMatrix);

        if (viewRadiusChange !== 0) {
            world.setViewRadius(world.viewRadius + viewRadiusChange);
            viewRadiusChange = 0;
            updateProjection();
            mat4.multiply(viewProjMatrix, projMatrix, viewMatrix);
            mat4.invert(invViewProjMatrix, viewProjMatrix);
        }
        if (caveCullingToggle) {
            world.caveCulling = !world.caveCulling;
            caveCullingToggle = false;
        }
        world.update(camPosition);

        const visible = world.cull(viewProjMatrix, camPosition);
        visibleChunks = visible.length;

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);

        if (maskHistoryStale) {
            shadowTargets.historyValid = false;
            maskHistoryStale = false;
        }
        if (halfResShadows) {
            // 1. half resolution: depth and face direction of the nearest surface (cheap fragment shader)
            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTargets.geometryFramebuffer);
            gl.viewport(0, 0, shadowTargets.width, shadowTargets.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(gbuffer.program);
            gl.uniformMatrix4fv(gbuffer.locations.viewProj, false, viewProjMatrix);
            world.draw(visible, camPosition, gbuffer.locations.chunkOrigin);

            // 2. shadow mask: reused from the previous frame, or one shadow ray per half resolution pixel
            const current = shadowTargets.current = 1 - shadowTargets.current;
            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTargets.maskFramebuffers[current]);
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(shadow.program);
            gl.uniformMatrix4fv(shadow.locations.invViewProj, false, invViewProjMatrix);
            gl.uniformMatrix4fv(shadow.locations.prevViewProj, false, prevViewProjMatrix);
            gl.uniform3fv(shadow.locations.lightDir, light.lightDir);
            gl.uniform1i(shadow.locations.historyMask, 6 - current); // units 5 and 6 hold masks 0 and 1
            gl.uniform1i(shadow.locations.frameIndex, frameIndex);
            gl.uniform1i(shadow.locations.refreshAll, shadowTargets.historyValid ? 0 : 1);
            setShadowWindow(shadow);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);
            shadowTargets.historyValid = true;

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        // sky radiance texture, when the sun has moved
        if (skyLutAngle === null || Math.abs(hourAngle - skyLutAngle) > 0.002) {
            skyLutAngle = hourAngle;
            gl.bindFramebuffer(gl.FRAMEBUFFER, skyLutFramebuffer);
            gl.viewport(0, 0, SKY_LUT_SIZE[0], SKY_LUT_SIZE[1]);
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(skyLut.program);
            gl.uniform3fv(skyLut.locations.sunDir, light.sunDir);
            gl.uniform3fv(skyLut.locations.moonDir, light.moonDir);
            gl.uniform1f(skyLut.locations.moonSky, light.moonSky);
            gl.uniform2f(skyLut.locations.lutSize, SKY_LUT_SIZE[0], SKY_LUT_SIZE[1]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        // 3. full resolution color, shadows read from the mask (or traced per pixel)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(color.program);
        gl.uniformMatrix4fv(color.locations.viewProj, false, viewProjMatrix);
        setSky(color);
        gl.uniform3fv(color.locations.camPosition, camPosition);
        gl.uniform1i(color.locations.halfResShadows, halfResShadows ? 1 : 0);
        gl.uniform1i(color.locations.shadowMask, 5 + shadowTargets.current);
        gl.uniform2f(color.locations.depthRange, NEAR, farPlane());
        gl.uniform2f(color.locations.maskScale,
            shadowTargets.width / gl.drawingBufferWidth, shadowTargets.height / gl.drawingBufferHeight);
        gl.uniform1f(color.locations.fogDensity, 1.2 / viewDistance()); // fog = 0.95 at the view distance
        setShadowWindow(color);
        facesDrawn = world.draw(visible, camPosition, color.locations.chunkOrigin);

        // 4. sky last, on the far plane: only the pixels the terrain left empty are shaded
        gl.useProgram(sky.program);
        gl.uniformMatrix4fv(sky.locations.invViewProj, false, invViewProjMatrix);
        gl.uniform3fv(sky.locations.camPosition, camPosition);
        setSky(sky);
        gl.uniform3fv(sky.locations.moonDir, light.moonDir);
        gl.uniform3fv(sky.locations.sunDiskColor, vec3.scale(vec3.create(), light.sunColor, 40));
        gl.uniform3fv(sky.locations.moonDiskColor, vec3.scale(vec3.create(), light.moonColor, 25));
        gl.uniform1f(sky.locations.starVisibility, light.starVisibility);
        gl.depthMask(false);
        gl.depthFunc(gl.LEQUAL);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gpuTimer.end();
        mat4.copy(prevViewProjMatrix, viewProjMatrix);
        frameIndex++;

        frames++;
        const now = performance.now();
        if (now - statsTime > 500) {
            const gpuMs = gpuTimer.take();
            const stats = world.stats();
            statsElement.textContent =
                `${(frames * 1000 / (now - statsTime)).toFixed(0)} fps` +
                (gpuMs !== null ? ` | GPU ${gpuMs.toFixed(2)} ms` : "") +
                ` | chunks ${visibleChunks} visible` +
                ` | columns ${stats.meshed} meshed / ${stats.loaded} loaded, ${stats.pending} pending` +
                ` | view ${world.viewRadius} (+/-)` +
                ` | cave culling ${world.caveCulling ? "on" : "off"} (c)` +
                ` | ${(facesDrawn * 2 / 1e6).toFixed(2)} M triangles` +
                ` | ${canvas.width}x${canvas.height}` +
                ` | pos ${Array.from(camPosition, v => v.toFixed(1)).join(" ")}` +
                ` | shadows ${halfResShadows ? "half" : "full"} res (h)` +
                ` | ${clockTime(hourAngle)} (t: fast)`;
            frames = 0;
            statsTime = now;
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}


init();
