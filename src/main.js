import { mat4, vec3 } from "gl-matrix";
import { moveWithCollisions } from "./collision";
import { CHUNK_SIZE, SEA_LEVEL } from "./constants";
import { createCloudNoiseTexture } from "./cloudNoise";
import { createLeafTextures } from "./leafTextures";
import { createVoxelTextures } from "./textures";
import { clockTime, createDaylight, daylight } from "./daylight";
import { CanopyMap } from "./canopy";
import { TreeRenderer } from "./trees";
import { frustumPlanes } from "./utils";
import { World } from "./world";
var vshader = require('./vertex.glsl');
var fshader = require('./fragment.glsl');
var gbufferFshader = require('./gbuffer_fragment.glsl');
var shadowFshader = require('./shadow_fragment.glsl');
var skyVshader = require('./sky_vertex.glsl');
var skyFshader = require('./sky_fragment.glsl');
var skyLutFshader = require('./sky_lut_fragment.glsl');
var atmosphereFshader = require('./atmosphere_fragment.glsl');
var textureGenFshader = require('./texture_gen_fragment.glsl');
var waterVshader = require('./water_vertex.glsl');
var waterFshader = require('./water_fragment.glsl');
var underwaterFshader = require('./underwater_fragment.glsl');
var treeVshader = require('./tree_vertex.glsl');
var treeFshader = require('./tree_fragment.glsl');
var treeGbufferFshader = require('./tree_gbuffer_fragment.glsl');
var treeDepthFshader = require('./tree_depth_fragment.glsl');

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
const SKY_UNIFORMS = ["skyLUT", "sunDir", "lightDir", "lightColor", "exposure", "rawOutput", "underwaterDensity"];
// uniforms of clouds.glsl and atmosphere.glsl
const CLOUD_UNIFORMS = ["cloudNoise", "cloudTime", "cloudCoverage"];
const ATMOSPHERE_UNIFORMS = ["atmosphereScatter", "screenSize", "atmosphereOn"];
// weather presets (cloud coverage), w cycles through them
const WEATHERS = [["fair", 0.35], ["cloudy", 0.55], ["overcast", 0.85], ["clear", 0.0]]; // the first is the default
// uniforms of tree_shadow.glsl
const TREE_SHADOW_UNIFORMS = ["treeShadowMap", "treeShadowMatrix", "treeShadowOn"];
const CANOPY_UNIFORMS = ["canopyTex", "canopyOrigin", "canopySize", "canopyOn"];
const TREE_SHADOW_SIZE = 2048;
const TREE_SHADOW_RADIUS = 128; // half side of the area of the tree shadow map, around the camera
// the tree shadow map is rendered again only when the light turned by this much, the camera moved by this much, or
// trees appeared or disappeared: in between nothing moves, so the shadows never shimmer
const TREE_SHADOW_LIGHT_STEP = 0.004; // radians: about every second at the normal speed of the sun
const TREE_SHADOW_MOVE_STEP = 16;
// uniforms of shadow.glsl
const SHADOW_UNIFORMS = ["brickTex", "coarseTex", "windowMin", "windowSize", "brickOrigin", "coarseOrigin",
    "horizonTex", "horizonOrigin", "horizonStep", "horizonValid"];

let camTheta = 0, camPhi = -0.35; // looking a bit down

// view from the URL: #pos=x,y,z&look=yaw,pitch (degrees)&time=hh.h (hours)&pause (time stopped)
// "v" writes the current view into the URL, to come back to it or share it
const viewParams = new URLSearchParams(window.location.hash.slice(1));
function numbers(name) {
    const value = viewParams.get(name);
    if (!value) return null;
    const list = value.split(",").map(Number);
    return list.every(Number.isFinite) ? list : null;
}
let timePaused = viewParams.has("pause");
let camPosition = vec3.create();
let keysDown = {};
// shadow rays traced at half resolution (4 times fewer rays), or one per pixel
let halfResShadows = true;
let viewRadiusChange = 0;
let caveCullingToggle = false;
let maskHistoryStale = false;
let aoHistoryStale = false; // the occlusion does not depend on the sun: only reset when the mask stops being updated
let writeViewToUrl = false;
let weather = 0;
let lightShafts = true;

function onkeydown(event) {
    keysDown[event.key] = true;
    if (event.key === "h") {
        halfResShadows = !halfResShadows;
        maskHistoryStale = true;
        aoHistoryStale = true;
    }
    if (event.key === "w") {
        weather = (weather + 1) % WEATHERS.length;
    }
    if (event.key === "g") {
        lightShafts = !lightShafts;
    }
    if (event.key === "v") {
        writeViewToUrl = true;
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
    // two masks (shadows, units 5 and 6; ambient occlusion, units 16 and 17): one is written while the other
    // (previous frame) is read, then they swap
    const masks = [createTexture2D(gl, gl.TEXTURE5, gl.RGBA8, width, height), createTexture2D(gl, gl.TEXTURE6, gl.RGBA8, width, height)];
    const aoMasks = [createTexture2D(gl, gl.TEXTURE16, gl.R8, width, height), createTexture2D(gl, gl.TEXTURE17, gl.R8, width, height)];
    gl.activeTexture(gl.TEXTURE0);
    const maskFramebuffers = masks.map((mask, i) => {
        const framebuffer = createFramebuffer(gl, mask, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, aoMasks[i], 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return framebuffer;
    });
    return {
        width, height, depth, face, masks, aoMasks,
        current: 0, // index of the mask written this frame
        historyValid: false,
        aoHistoryValid: false,
        geometryFramebuffer: createFramebuffer(gl, face, depth),
        maskFramebuffers,
    };
}

/**
 * Quarter resolution targets of the clouds and light shafts, twice (current frame and previous frame):
 * scattered light + transmittance (units 9, 10), distance where the view ray ends (units 11, 12).
 */
function createAtmosphereTargets(gl, screenWidth, screenHeight) {
    const width = Math.max(1, Math.ceil(screenWidth / 4));
    const height = Math.max(1, Math.ceil(screenHeight / 4));
    const targets = { width, height, current: 0, historyValid: false, scatter: [], depth: [], framebuffers: [] };
    for (let i = 0; i < 2; i++) {
        const scatter = createTexture2D(gl, gl.TEXTURE9 + i, gl.RGBA16F, width, height);
        const depth = createTexture2D(gl, gl.TEXTURE11 + i, gl.R16F, width, height);
        // bilinear reads of the history
        for (const texture of [scatter, depth]) {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }
        gl.activeTexture(gl.TEXTURE9 + i);
        gl.bindTexture(gl.TEXTURE_2D, scatter);
        gl.activeTexture(gl.TEXTURE11 + i);
        gl.bindTexture(gl.TEXTURE_2D, depth);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scatter, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Atmosphere framebuffer incomplete : 0x" + status.toString(16));
        targets.scatter.push(scatter);
        targets.depth.push(depth);
        targets.framebuffers.push(framebuffer);
    }
    gl.activeTexture(gl.TEXTURE0);
    return targets;
}

function deleteAtmosphereTargets(gl, targets) {
    targets.framebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
    [...targets.scatter, ...targets.depth].forEach(texture => gl.deleteTexture(texture));
}

function deleteShadowTargets(gl, targets) {
    gl.deleteFramebuffer(targets.geometryFramebuffer);
    targets.maskFramebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
    gl.deleteTexture(targets.depth);
    gl.deleteTexture(targets.face);
    targets.masks.forEach(mask => gl.deleteTexture(mask));
    targets.aoMasks.forEach(mask => gl.deleteTexture(mask));
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
        ["viewProj", "chunkOrigin", "camPosition", "halfResShadows", "shadowMask", "maskScale", "halfDepth", "depthRange", "fogDensity", "voxelAlbedo", "voxelNormals", "reflectionPass", "seaLevel", "aoMask", ...TREE_SHADOW_UNIFORMS, ...CANOPY_UNIFORMS,
            ...SKY_UNIFORMS, ...SHADOW_UNIFORMS, ...CLOUD_UNIFORMS, ...ATMOSPHERE_UNIFORMS]);
    const gbuffer = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, gbufferFshader),
        ["viewProj", "chunkOrigin"]);
    const shadow = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, shadowFshader),
        ["invViewProj", "lightDir", "halfDepth", "halfFace", "historyMask", "prevViewProj", "frameIndex", "refreshAll", "historyAO", "aoHistoryValid", "camPosition",
            ...SHADOW_UNIFORMS, ...CLOUD_UNIFORMS]);
    const sky = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, skyFshader),
        ["invViewProj", "camPosition", "moonDir", "sunDiskColor", "moonDiskColor", "starVisibility", ...SKY_UNIFORMS, ...CLOUD_UNIFORMS, ...ATMOSPHERE_UNIFORMS]);
    const skyLut = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, skyLutFshader),
        ["sunDir", "moonDir", "moonSky", "lutSize"]);
    const atmosphere = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, atmosphereFshader),
        ["halfDepth", "historyScatter", "historyDepth", "invViewProj", "prevViewProj", "camPosition", "frameIndex", "historyValid", "lightShafts", "shaftDistance",
            ...SKY_UNIFORMS, ...SHADOW_UNIFORMS, ...CLOUD_UNIFORMS, ...TREE_SHADOW_UNIFORMS]);

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
    // clouds and light shafts need float render targets
    const atmosphereEnabled = floatTargets;
    createCloudNoiseTexture(gl, gl.TEXTURE8);
    const water = createProgram(gl, compileShader(gl, gl.VERTEX_SHADER, waterVshader), compileShader(gl, gl.FRAGMENT_SHADER, waterFshader),
        ["viewProj", "chunkOrigin", "seaLevel", "camPosition", "fogDensity", "waterTime", "reflectionTex", "reflectionOn", "halfDepth",
            "hasHalfDepth", "depthRange", "voxelNormals", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS, ...CLOUD_UNIFORMS, ...ATMOSPHERE_UNIFORMS]);
    const underwater = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, underwaterFshader),
        ["veil", ...SKY_UNIFORMS]);
    const treeVertexShader = compileShader(gl, gl.VERTEX_SHADER, treeVshader);
    const TREE_UNIFORMS = ["viewProj", "modelOrigin", "voxelSize", "windTime", "cutout", "voxelAlbedo", "voxelNormals", "leafTextures"];
    const treeColor = createProgram(gl, treeVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, treeFshader),
        [...TREE_UNIFORMS, "camPosition", "halfResShadows", "shadowMask", "maskScale", "fogDensity", "reflectionPass", "seaLevel",
            ...SKY_UNIFORMS, ...SHADOW_UNIFORMS, ...CLOUD_UNIFORMS, ...ATMOSPHERE_UNIFORMS, ...TREE_SHADOW_UNIFORMS, ...CANOPY_UNIFORMS]);
    const treeGbuffer = createProgram(gl, treeVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, treeGbufferFshader), TREE_UNIFORMS);
    const treeDepth = createProgram(gl, treeVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, treeDepthFshader), TREE_UNIFORMS);
    const textureGen = createProgram(gl, fullscreenVertexShader, compileShader(gl, gl.FRAGMENT_SHADER, textureGenFshader), ["layer", "size"]);
    createVoxelTextures(gl, textureGen, gl.TEXTURE13, gl.TEXTURE14);
    createLeafTextures(gl, gl.TEXTURE19);
    let cloudTime = 0;


    const world = new World(gl);
    const trees = new TreeRenderer(gl, world);
    const canopy = new CanopyMap(gl, gl.TEXTURE20, null);
    world.pool.buildTreeModels(models => {
        trees.setModels(models);
        canopy.crowns = trees.crowns;
        canopy.valid = false; // build it now
        world.treesVersion = (world.treesVersion || 0) + 1; // and render the tree shadow map again
    });

    // shadow map of the trees (unit 18): depth seen from the light, compared in the shaders
    gl.activeTexture(gl.TEXTURE18);
    const treeShadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, treeShadowTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, TREE_SHADOW_SIZE, TREE_SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    const treeShadowFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, treeShadowFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, treeShadowTexture, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const treeShadowMatrix = mat4.create(), treeLightView = mat4.create(), treeLightProj = mat4.create();
    let treeShadowOn = false;
    const treeShadowState = { light: null, center: null, version: -1 };
    // start above the ground at the center of the world
    vec3.set(camPosition, 0.5, 0.5, world.surfaceHeight(0, 0) + 25);
    const startPos = numbers("pos"), startLook = numbers("look");
    if (startPos && startPos.length === 3) vec3.set(camPosition, ...startPos);
    if (startLook && startLook.length === 2) {
        camTheta = startLook[0] * Math.PI / 180;
        camPhi = startLook[1] * Math.PI / 180;
    }

    // texture units: 0 voxel bricks, 1 coarse occupancy (shadow window), 2 horizon heights, 3 half depth, 4 half face, 5 and 6 shadow masks,
    // 7 sky, 8 cloud noise, 9 to 12 light shafts (current and previous frame), 13 and 14 voxel textures (albedo, normals), 15 water reflection,
    // 16 and 17 ambient occlusion masks, 18 tree shadow map, 19 foliage (pixel art), 20 canopy map
    for (const program of [color, shadow]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.brickTex, 0);
        gl.uniform1i(program.locations.coarseTex, 1);
    }
    // horizon height map (unit 2) for every program tracing shadow rays
    for (const program of [color, shadow, atmosphere, water]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.horizonTex, 2);
    }
    for (const program of [color, sky, atmosphere]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.skyLUT, 7);
    }
    for (const program of [color, atmosphere, shadow, sky]) {
        gl.useProgram(program.program);
        gl.uniform1i(program.locations.cloudNoise, 8);
    }
    gl.useProgram(atmosphere.program);
    gl.uniform1i(atmosphere.locations.treeShadowMap, 18);
    gl.uniform1i(atmosphere.locations.brickTex, 0);
    gl.uniform1i(atmosphere.locations.coarseTex, 1);
    gl.uniform1i(atmosphere.locations.halfDepth, 3);
    gl.useProgram(color.program);
    gl.uniform1i(color.locations.halfDepth, 3);
    gl.uniform1i(color.locations.voxelAlbedo, 13);
    gl.uniform1i(color.locations.voxelNormals, 14);
    gl.uniform1i(color.locations.treeShadowMap, 18);
    gl.uniform1i(color.locations.canopyTex, 20);
    gl.useProgram(treeColor.program);
    for (const [name, unit] of [["brickTex", 0], ["coarseTex", 1], ["horizonTex", 2], ["skyLUT", 7], ["cloudNoise", 8], ["treeShadowMap", 18],
        ["voxelAlbedo", 13], ["voxelNormals", 14], ["leafTextures", 19], ["canopyTex", 20]]) {
        gl.uniform1i(treeColor.locations[name], unit);
    }
    gl.useProgram(treeGbuffer.program);
    gl.uniform1i(treeGbuffer.locations.voxelAlbedo, 13);
    gl.uniform1i(treeGbuffer.locations.leafTextures, 19);
    gl.uniform1f(treeColor.locations.seaLevel, SEA_LEVEL);
    gl.useProgram(color.program);
    gl.uniform1f(color.locations.seaLevel, SEA_LEVEL);
    gl.useProgram(water.program);
    gl.uniform1i(water.locations.skyLUT, 7);
    gl.uniform1i(water.locations.cloudNoise, 8);
    gl.uniform1i(water.locations.brickTex, 0);
    gl.uniform1i(water.locations.coarseTex, 1);
    gl.uniform1i(water.locations.halfDepth, 3);
    gl.uniform1i(water.locations.reflectionTex, 15);
    gl.uniform1i(water.locations.voxelNormals, 14);
    gl.uniform1f(water.locations.seaLevel, SEA_LEVEL);
    gl.useProgram(underwater.program);
    gl.uniform1i(underwater.locations.skyLUT, 7);
    gl.useProgram(shadow.program);
    gl.uniform1i(shadow.locations.halfDepth, 3);
    gl.uniform1i(shadow.locations.halfFace, 4);

    var projMatrix = mat4.create();
    var shadowTargets = null;
    var atmosphereTargets = null;

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

    // planar reflection of the water, rendered mirrored at half the CSS resolution (unit 15), linear HDR
    var reflection = null;
    function createReflectionTarget() {
        if (!floatTargets) return null;
        const width = Math.max(1, Math.ceil(window.innerWidth / 2)), height = Math.max(1, Math.ceil(window.innerHeight / 2));
        const texture = createTexture2D(gl, gl.TEXTURE15, gl.RGBA16F, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
        const framebuffer = createFramebuffer(gl, texture, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        return { width, height, texture, depth, framebuffer };
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
        if (reflection) {
            gl.deleteFramebuffer(reflection.framebuffer);
            gl.deleteTexture(reflection.texture);
            gl.deleteRenderbuffer(reflection.depth);
        }
        reflection = createReflectionTarget();
        if (atmosphereEnabled) {
            if (atmosphereTargets) {
                deleteAtmosphereTargets(gl, atmosphereTargets);
            }
            atmosphereTargets = createAtmosphereTargets(gl, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }
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
    // mirror about the water plane z = SEA_LEVEL
    var mirrorMatrix = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 2 * SEA_LEVEL, 1);
    var reflViewProjMatrix = mat4.create();
    var reflInvViewProjMatrix = mat4.create();
    var mirroredCamPosition = vec3.create();
    var waterTime = 0;
    var underWater = false;

    var hourAngle = -1.0; // about 8 in the morning
    const startTime = numbers("time");
    if (startTime) hourAngle = (startTime[0] - 12) / 24 * 2 * Math.PI;
    var light = createDaylight();
    var wasNight = null;
    var lastTime = performance.now();

    function setClouds(program) {
        gl.uniform1f(program.locations.cloudTime, cloudTime);
        gl.uniform1f(program.locations.cloudCoverage, WEATHERS[weather][1]);
    }
    function setAtmosphere(program) {
        const on = atmosphereEnabled;
        gl.uniform1i(program.locations.atmosphereOn, on ? 1 : 0);
        gl.uniform1i(program.locations.atmosphereScatter, 9 + (on ? atmosphereTargets.current : 0));
        gl.uniform2f(program.locations.screenSize, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    function setSky(program) {
        gl.uniform3fv(program.locations.sunDir, light.sunDir);
        gl.uniform3fv(program.locations.lightDir, light.lightDir);
        gl.uniform3fv(program.locations.lightColor, light.lightColor);
        gl.uniform1f(program.locations.exposure, light.exposure);
        gl.uniform1f(program.locations.underwaterDensity, underWater ? 0.06 : 0.0);
    }

    function setTreeShadow(program) {
        gl.uniformMatrix4fv(program.locations.treeShadowMatrix, false, treeShadowMatrix);
        gl.uniform1i(program.locations.treeShadowOn, treeShadowOn ? 1 : 0);
    }
    function setCanopy(program) {
        gl.uniform2fv(program.locations.canopyOrigin, canopy.origin);
        gl.uniform1f(program.locations.canopySize, canopy.size);
        gl.uniform1i(program.locations.canopyOn, canopy.valid ? 1 : 0);
    }

    // frustum planes without the bottom and top ones (trees above or below the screen show in the reflections)
    const treePlanes = new Float32Array(24);
    function sidePlanes(matrix) {
        frustumPlanes(treePlanes, matrix);
        for (let i = 8; i < 16; i++) treePlanes[i] = (i % 4 === 3) ? 1 : 0;
        return treePlanes;
    }

    /** depth of the trees seen from the light, around the camera, when needed (see TREE_SHADOW_LIGHT_STEP) */
    function renderTreeShadows(fastTime) {
        treeShadowOn = -light.lightDir[2] > 0.03;
        if (!treeShadowOn) return;
        const state = treeShadowState;
        const lightTurned = !state.light || fastTime || vec3.angle(state.light, light.lightDir) > TREE_SHADOW_LIGHT_STEP;
        const cameraMoved = !state.center || vec3.distance(state.center, camPosition) > TREE_SHADOW_MOVE_STEP;
        if (!lightTurned && !cameraMoved && state.version === world.treesVersion) return;
        if (lightTurned) state.light = vec3.clone(light.lightDir);
        state.center = vec3.clone(camPosition);
        state.version = world.treesVersion;
        // light space with a fixed orientation between light steps; the area is snapped to its texels, so moving the
        // camera does not move the shadows
        const up = Math.abs(state.light[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
        mat4.lookAt(treeLightView, [0, 0, 0], state.light, up);
        const c = vec3.transformMat4(vec3.create(), camPosition, treeLightView);
        const texel = 2 * TREE_SHADOW_RADIUS / TREE_SHADOW_SIZE;
        const sx = Math.round(c[0] / texel) * texel, sy = Math.round(c[1] / texel) * texel;
        mat4.ortho(treeLightProj, sx - TREE_SHADOW_RADIUS, sx + TREE_SHADOW_RADIUS, sy - TREE_SHADOW_RADIUS, sy + TREE_SHADOW_RADIUS,
            -c[2] - 400, -c[2] + 400);
        mat4.multiply(treeShadowMatrix, treeLightProj, treeLightView);

        trees.gather("shadow", camPosition, null, TREE_SHADOW_RADIUS * 1.5, 1); // full foliage: cheaper, no gaps needed
        gl.bindFramebuffer(gl.FRAMEBUFFER, treeShadowFramebuffer);
        gl.viewport(0, 0, TREE_SHADOW_SIZE, TREE_SHADOW_SIZE);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2, 4);
        gl.cullFace(gl.FRONT); // back faces in the map: less self shadowing on the lit faces
        gl.useProgram(treeDepth.program);
        gl.uniformMatrix4fv(treeDepth.locations.viewProj, false, treeShadowMatrix);
        gl.uniform1f(treeDepth.locations.windTime, 0);
        trees.draw("shadow", treeDepth.locations);
        gl.cullFace(gl.BACK);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    function setShadowWindow(program) {
        gl.uniform3fv(program.locations.windowMin, world.windowMin);
        gl.uniform3fv(program.locations.windowSize, world.windowSize);
        gl.uniform3iv(program.locations.brickOrigin, world.brickOrigin);
        gl.uniform3iv(program.locations.coarseOrigin, world.coarseOrigin);
        gl.uniform2fv(program.locations.horizonOrigin, world.horizonOrigin);
        gl.uniform1f(program.locations.horizonStep, 16);
        gl.uniform1i(program.locations.horizonValid, world.horizonValid ? 1 : 0);
    }

    const gpuTimer = createGpuTimer(gl);
    const statsElement = document.getElementById("stats");
    let frames = 0, statsTime = performance.now(), visibleChunks = 0, facesDrawn = 0, waterFaces = 0;


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
        if (!timePaused || timeScale > 1) hourAngle += SUN_SPEED * dt * timeScale;
        cloudTime += dt * timeScale;
        waterTime += dt;
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

        underWater = world.isWater(Math.floor(camPosition[0]), Math.floor(camPosition[1]), Math.floor(camPosition[2] + 0.12));
        const visible = world.cull(viewProjMatrix, camPosition);
        visibleChunks = visible.length;
        renderTreeShadows(timeScale > 1);
        canopy.update(world, camPosition);
        trees.gather("camera", camPosition, sidePlanes(viewProjMatrix), viewDistance());

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);

        if (maskHistoryStale) {
            shadowTargets.historyValid = false;
            maskHistoryStale = false;
        }
        if (aoHistoryStale) {
            shadowTargets.aoHistoryValid = false;
            aoHistoryStale = false;
        }
        const atmosphereOn = atmosphereEnabled;
        if (halfResShadows || atmosphereOn) {
            // 1. half resolution: depth and face direction of the nearest surface (cheap fragment shader)
            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTargets.geometryFramebuffer);
            gl.viewport(0, 0, shadowTargets.width, shadowTargets.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(gbuffer.program);
            gl.uniformMatrix4fv(gbuffer.locations.viewProj, false, viewProjMatrix);
            world.draw(visible, camPosition, gbuffer.locations.chunkOrigin);
            gl.useProgram(treeGbuffer.program);
            gl.uniformMatrix4fv(treeGbuffer.locations.viewProj, false, viewProjMatrix);
            gl.uniform1f(treeGbuffer.locations.windTime, waterTime);
            trees.draw("camera", treeGbuffer.locations);
        }
        if (halfResShadows) {

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
            gl.uniform1i(shadow.locations.historyAO, 17 - current); // units 16 and 17 hold the occlusion 0 and 1
            gl.uniform1i(shadow.locations.aoHistoryValid, shadowTargets.aoHistoryValid ? 1 : 0);
            gl.uniform3fv(shadow.locations.camPosition, camPosition);
            setClouds(shadow);
            setShadowWindow(shadow);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);
            shadowTargets.historyValid = true;
            shadowTargets.aoHistoryValid = true;
        }
        if (halfResShadows || atmosphereOn) {
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

        // clouds and light shafts, quarter resolution, accumulated over frames
        if (atmosphereOn) {
            const current = atmosphereTargets.current = 1 - atmosphereTargets.current;
            gl.bindFramebuffer(gl.FRAMEBUFFER, atmosphereTargets.framebuffers[current]);
            gl.viewport(0, 0, atmosphereTargets.width, atmosphereTargets.height);
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(atmosphere.program);
            gl.uniformMatrix4fv(atmosphere.locations.invViewProj, false, invViewProjMatrix);
            gl.uniformMatrix4fv(atmosphere.locations.prevViewProj, false, prevViewProjMatrix);
            gl.uniform3fv(atmosphere.locations.camPosition, camPosition);
            gl.uniform1i(atmosphere.locations.frameIndex, frameIndex);
            gl.uniform1i(atmosphere.locations.historyScatter, 9 + (1 - current));
            gl.uniform1i(atmosphere.locations.historyDepth, 11 + (1 - current));
            // history dropped while time runs fast (the light moves too much)
            gl.uniform1i(atmosphere.locations.historyValid, atmosphereTargets.historyValid && timeScale === 1 ? 1 : 0);
            gl.uniform1i(atmosphere.locations.lightShafts, lightShafts ? 1 : 0);
            gl.uniform1f(atmosphere.locations.shaftDistance, viewDistance());
            setSky(atmosphere);
            setClouds(atmosphere);
            setShadowWindow(atmosphere);
            setTreeShadow(atmosphere);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            atmosphereTargets.historyValid = true;
        }

        // terrain with full shading; mirrored = the reflection of the water (no mask shadows, no light shafts)
        function drawTerrainColor(chunks, matrix, eye, mirrored) {
            gl.useProgram(color.program);
            gl.uniformMatrix4fv(color.locations.viewProj, false, matrix);
            setSky(color);
            setClouds(color);
            setAtmosphere(color);
            gl.uniform3fv(color.locations.camPosition, eye);
            gl.uniform1i(color.locations.halfResShadows, halfResShadows && !mirrored ? 1 : 0);
            gl.uniform1i(color.locations.reflectionPass, mirrored ? 1 : 0);
            gl.uniform1i(color.locations.rawOutput, mirrored ? 1 : 0);
            if (mirrored) gl.uniform1i(color.locations.atmosphereOn, 0);
            gl.uniform1i(color.locations.shadowMask, 5 + shadowTargets.current);
            gl.uniform1i(color.locations.aoMask, 16 + shadowTargets.current);
            gl.uniform2f(color.locations.depthRange, NEAR, farPlane());
            gl.uniform2f(color.locations.maskScale,
                shadowTargets.width / gl.drawingBufferWidth, shadowTargets.height / gl.drawingBufferHeight);
            gl.uniform1f(color.locations.fogDensity, 1.2 / viewDistance()); // fog = 0.95 at the view distance
            setShadowWindow(color);
            setTreeShadow(color);
            setCanopy(color);
            return world.draw(chunks, eye, color.locations.chunkOrigin);
        }

        // trees, shaded like the terrain; mirrored = in the reflection of the water
        function drawTrees(matrix, eye, mirrored) {
            gl.useProgram(treeColor.program);
            gl.uniformMatrix4fv(treeColor.locations.viewProj, false, matrix);
            gl.uniform1f(treeColor.locations.windTime, waterTime);
            setSky(treeColor);
            setClouds(treeColor);
            setAtmosphere(treeColor);
            setTreeShadow(treeColor);
            setCanopy(treeColor);
            gl.uniform3fv(treeColor.locations.camPosition, eye);
            gl.uniform1i(treeColor.locations.halfResShadows, halfResShadows && !mirrored ? 1 : 0);
            gl.uniform1i(treeColor.locations.reflectionPass, mirrored ? 1 : 0);
            gl.uniform1i(treeColor.locations.rawOutput, mirrored ? 1 : 0);
            if (mirrored) gl.uniform1i(treeColor.locations.atmosphereOn, 0);
            gl.uniform1i(treeColor.locations.shadowMask, 5 + shadowTargets.current);
            gl.uniform2f(treeColor.locations.maskScale,
                shadowTargets.width / gl.drawingBufferWidth, shadowTargets.height / gl.drawingBufferHeight);
            gl.uniform1f(treeColor.locations.fogDensity, 1.2 / viewDistance());
            setShadowWindow(treeColor);
            trees.draw("camera", treeColor.locations);
        }

        // sky on the far plane: only the pixels the terrain left empty are shaded
        function drawSky(inverseMatrix, eye, mirrored) {
            gl.useProgram(sky.program);
            gl.uniformMatrix4fv(sky.locations.invViewProj, false, inverseMatrix);
            gl.uniform3fv(sky.locations.camPosition, eye);
            setSky(sky);
            setClouds(sky);
            setAtmosphere(sky);
            gl.uniform1i(sky.locations.rawOutput, mirrored ? 1 : 0);
            if (mirrored) gl.uniform1i(sky.locations.atmosphereOn, 0);
            gl.uniform3fv(sky.locations.moonDir, light.moonDir);
            gl.uniform3fv(sky.locations.sunDiskColor, vec3.scale(vec3.create(), light.sunColor, 40));
            gl.uniform3fv(sky.locations.moonDiskColor, vec3.scale(vec3.create(), light.moonColor, 25));
            gl.uniform1f(sky.locations.starVisibility, light.starVisibility);
            gl.depthMask(false);
            gl.depthFunc(gl.LEQUAL);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.depthMask(true);
            gl.depthFunc(gl.LESS);
        }

        const waterChunks = visible.filter(chunk => chunk.nWaterFaces > 0);
        waterFaces = waterChunks.reduce((sum, chunk) => sum + chunk.nWaterFaces, 0);

        // planar reflection: the scene mirrored about the water plane, seen from the camera (only above the water)
        const reflectionOn = reflection !== null && waterChunks.length > 0 && camPosition[2] > SEA_LEVEL;
        if (reflectionOn) {
            mat4.multiply(reflViewProjMatrix, viewProjMatrix, mirrorMatrix);
            mat4.invert(reflInvViewProjMatrix, reflViewProjMatrix);
            vec3.set(mirroredCamPosition, camPosition[0], camPosition[1], 2 * SEA_LEVEL - camPosition[2]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, reflection.framebuffer);
            gl.viewport(0, 0, reflection.width, reflection.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.cullFace(gl.FRONT); // the mirror flips the winding
            drawTerrainColor(world.cullReflection(reflViewProjMatrix, mirroredCamPosition), reflViewProjMatrix, mirroredCamPosition, true);
            drawTrees(reflViewProjMatrix, mirroredCamPosition, true);
            gl.cullFace(gl.BACK);
            drawSky(reflInvViewProjMatrix, mirroredCamPosition, true);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        // 3. full resolution color, shadows read from the mask (or traced per pixel)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        facesDrawn = drawTerrainColor(visible, viewProjMatrix, camPosition, false);
        drawTrees(viewProjMatrix, camPosition, false);

        // 4. sky
        drawSky(invViewProjMatrix, camPosition, false);

        // 5. water, transparent over the terrain and the sky (premultiplied alpha), both sides visible
        if (waterChunks.length > 0) {
            gl.useProgram(water.program);
            gl.uniformMatrix4fv(water.locations.viewProj, false, viewProjMatrix);
            gl.uniform3fv(water.locations.camPosition, camPosition);
            gl.uniform1f(water.locations.fogDensity, 1.2 / viewDistance());
            gl.uniform1f(water.locations.waterTime, waterTime);
            gl.uniform1i(water.locations.reflectionOn, reflectionOn ? 1 : 0);
            gl.uniform1i(water.locations.hasHalfDepth, halfResShadows || atmosphereOn ? 1 : 0);
            gl.uniform2f(water.locations.depthRange, NEAR, farPlane());
            setSky(water);
            gl.uniform1i(water.locations.rawOutput, 0);
            setClouds(water);
            setAtmosphere(water);
            setShadowWindow(water);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            gl.disable(gl.CULL_FACE);
            for (const chunk of waterChunks) {
                gl.uniform3fv(water.locations.chunkOrigin, chunk.pos);
                chunk.drawWater(gl);
            }
            gl.bindVertexArray(null);
            gl.enable(gl.CULL_FACE);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
        }

        // 6. under the water: a veil over everything
        if (underWater) {
            gl.useProgram(underwater.program);
            setSky(underwater);
            gl.uniform1i(underwater.locations.rawOutput, 0);
            gl.uniform1f(underwater.locations.veil, 0.25);
            gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.disable(gl.BLEND);
            gl.enable(gl.DEPTH_TEST);
        }

        gpuTimer.end();
        mat4.copy(prevViewProjMatrix, viewProjMatrix);
        frameIndex++;

        if (writeViewToUrl) {
            writeViewToUrl = false;
            const hours = ((hourAngle / (2 * Math.PI)) * 24 + 12 + 240) % 24;
            const deg = a => (a * 180 / Math.PI).toFixed(1);
            history.replaceState(null, "", `#pos=${Array.from(camPosition, v => v.toFixed(1)).join(",")}` +
                `&look=${deg(camTheta)},${deg(camPhi)}&time=${hours.toFixed(2)}${timePaused ? "&pause" : ""}`);
        }

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
                ` | trees ${trees.sets.camera.trees} (${(trees.sets.camera.faces * 2 / 1e6).toFixed(2)} M triangles)` +
                (waterFaces > 0 ? ` | water ${(waterFaces / 1e3).toFixed(0)} k faces` : "") +
                ` | ${canvas.width}x${canvas.height}` +
                ` | pos ${Array.from(camPosition, v => v.toFixed(1)).join(" ")}` +
                ` | shadows ${halfResShadows ? "half" : "full"} res (h)` +
                ` | ${clockTime(hourAngle)} (t: fast)` +
                (atmosphereEnabled ? ` | ${WEATHERS[weather][0]} (w) | light shafts ${lightShafts ? "on" : "off"} (g)` : "");
            frames = 0;
            statsTime = now;
        }

        requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
}


init();
