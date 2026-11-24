#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;

// One shadow ray per half resolution pixel, written to the raw shadow mask (softened by soft_shadow_fragment.glsl for
// the color pass): r = lit (1) or in the shadow (0), g = face direction + 1 (0 = sky), b = face plane coordinate modulo
// 256, a = distance to the occluder (encodeOccluder), for the size of the penumbra.
// Second output: ambient occlusion of the surface by the voxels within AO_RADIUS (ray traced, accumulated over frames).
uniform sampler2D halfDepth;
uniform sampler2D halfFace;
uniform mat4 invViewProj;
uniform vec3 lightDir;
// temporal reuse
uniform sampler2D historyMask; // mask of the previous frame
uniform mat4 prevViewProj;
uniform int frameIndex;
uniform bool refreshAll;       // no usable history (first frame, resize, fast sun)
uniform sampler2D historyAO;   // ambient occlusion of the previous frame
uniform bool aoHistoryValid;   // false after a resize (the occlusion does not depend on the sun)
uniform vec3 camPosition;

layout(location = 0) out vec4 fragMask;
layout(location = 1) out vec4 fragAO;

const float AO_RADIUS = 10.0;
const int AO_RAYS = 2;
const float AO_BLEND = 0.15; // weight of the new rays: about 6 frames of history
// beyond, 10 voxels are a few pixels: no rays (fades out over the last quarter)
const float AO_DISTANCE = 200.0;

@import ./shadow;
@import ./clouds;

// The shadow of a surface point does not depend on the camera, and the sun moves slowly: the previous mask is
// reused where it shows the same face plane, all lit or all in the shadow (shadow edges are traced every frame,
// reprojecting them would move them by a pixel at each camera motion). Tiles of 8x8 pixels are traced again in turn (every pixel at least
// every REFRESH_PERIOD frames, so sun motion and destructions show up), and so are newly visible surfaces.
// Whole tiles keep the pixels traced together by the GPU coherent.
const int REFRESH_PERIOD = 8;
const int TREE_FACE = 7; // face id of the tree pixels (tree_gbuffer_fragment.glsl)

// distance to the occluder in 8 bits: finer close up (contact shadows), up to 2048 voxels
float encodeOccluder(float d) {
    return sqrt(clamp(d / 2048.0, 0.0, 1.0));
}

float reusedShadow(vec3 pos, int face, float plane, out bool found, out float occluder) {
    found = false;
    occluder = 0.0;
    vec4 prev = prevViewProj * vec4(pos, 1.0);
    if(prev.w <= 0.0) return 0.0;
    vec2 uv = prev.xy / prev.w * 0.5 + 0.5;
    if(any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return 0.0;
    ivec2 size = textureSize(historyMask, 0);
    vec2 h = uv * vec2(size) - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    float sum = 0.0, weightSum = 0.0, lo = 1.0, hi = 0.0, occluderSum = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            vec4 m = texelFetch(historyMask, clamp(base + ivec2(i, j), ivec2(0), size - 1), 0);
            if(int(m.g * 255.0 + 0.5) - 1 == face && floor(m.b * 255.0 + 0.5) == plane) {
                float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
                sum += m.r * w;
                occluderSum += m.a * w;
                weightSum += w;
                lo = min(lo, m.r);
                hi = max(hi, m.r);
            }
        }
    }
    found = weightSum > 0.0 && hi - lo < 0.5;
    occluder = found ? occluderSum / weightSum : 0.0; // already encoded
    return found ? sum / weightSum : 0.0;
}

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

// ambient occlusion of the previous frame at the same place, on the same face plane
float reusedAO(vec3 pos, int face, float plane, out bool found) {
    found = false;
    vec4 prev = prevViewProj * vec4(pos, 1.0);
    if(prev.w <= 0.0) return 1.0;
    vec2 uv = prev.xy / prev.w * 0.5 + 0.5;
    if(any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return 1.0;
    ivec2 size = textureSize(historyMask, 0);
    vec2 h = uv * vec2(size) - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    float sum = 0.0, weightSum = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            ivec2 texel = clamp(base + ivec2(i, j), ivec2(0), size - 1);
            vec4 m = texelFetch(historyMask, texel, 0);
            if(int(m.g * 255.0 + 0.5) - 1 == face && floor(m.b * 255.0 + 0.5) == plane) {
                float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
                sum += texelFetch(historyAO, texel, 0).r * w;
                weightSum += w;
            }
        }
    }
    found = weightSum > 0.0;
    return found ? sum / weightSum : 1.0;
}

// AO_RAYS rays in the hemisphere of the face (cosine distributed, new directions every frame); 1 = open
float traceAO(vec3 pos, int face, ivec2 p) {
    vec3 n = NORMALS[face];
    vec3 t = face < 2 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 b = cross(n, t);
    float noise = fract(52.9829189 * fract(dot(vec2(p), vec2(0.06711056, 0.00583715))));
    float sum = 0.0;
    for(int k = 0; k < AO_RAYS; k++) {
        float index = float(frameIndex % 256) * float(AO_RAYS) + float(k);
        vec2 u = fract(vec2(noise, noise * 7.13) + index * vec2(0.7548776662, 0.5698402910)); // R2 sequence
        float r = sqrt(u.x), phi = 6.2831853 * u.y;
        vec3 dir = normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(1.0 - u.x, 0.0)));
        sum += occlusionDistance(pos + n * 0.01, dir, AO_RADIUS) / AO_RADIUS;
    }
    return sum / float(AO_RAYS);
}


void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int face = int(texelFetch(halfFace, p, 0).r * 255.0 + 0.5) - 1;
    if(face < 0) {
        fragMask = vec4(1.0, 0.0, 0.0, 1.0); // sky
        fragAO = vec4(1.0);
        return;
    }
    vec3 sunDir = -lightDir;
    if(face == TREE_FACE) {
        // a tree (not in the voxel textures): its terrain shadow from its surface, no normal, no occlusion here
        vec4 treePoint = invViewProj * vec4((vec2(p) + 0.5) / vec2(textureSize(halfDepth, 0)) * 2.0 - 1.0, texelFetch(halfDepth, p, 0).r * 2.0 - 1.0, 1.0);
        vec3 treePos = treePoint.xyz / treePoint.w;
        float treeLit = 0.0, treeOccluder = 0.0;
        if(sunDir.z > 0.0) {
            bool found = false;
            bool refresh = refreshAll || ((p.x >> 3) + (p.y >> 3) * 3 + frameIndex) % REFRESH_PERIOD == 0;
            if(!refresh) treeLit = reusedShadow(treePos, TREE_FACE, 0.0, found, treeOccluder);
            if(!found) {
                float d;
                treeLit = traceShadow(treePos + sunDir * 0.3, sunDir, d);
                treeOccluder = encodeOccluder(d);
            }
        }
        fragMask = vec4(treeLit, float(TREE_FACE + 1) / 255.0, 0.0, treeOccluder);
        fragAO = vec4(1.0);
        return;
    }
    vec3 normal = NORMALS[face];

    // world position of the surface, from the depth buffer
    float depth = texelFetch(halfDepth, p, 0).r;
    vec2 ndc = (vec2(p) + 0.5) / vec2(textureSize(halfDepth, 0)) * 2.0 - 1.0;
    vec4 world = invViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
    vec3 pos = world.xyz / world.w;
    // voxel faces lie on integer planes: snapping removes the depth buffer imprecision along the normal,
    // which would otherwise start the ray inside the voxel and shadow the face itself
    int axis = face >> 1;
    pos[axis] = floor(pos[axis] + 0.5);

    float plane = mod(pos[axis], 256.0);

    float lit = 0.0, occluder = 0.0; // faces turned away from the light: sharp terminator
    if(dot(normal, sunDir) > 0.0) {
        bool found = false;
        bool refresh = refreshAll || ((p.x >> 3) + (p.y >> 3) * 3 + frameIndex) % REFRESH_PERIOD == 0;
        if(!refresh) {
            lit = reusedShadow(pos, face, plane, found, occluder);
        }
        if(!found) {
            float d;
            lit = traceShadow(pos + normal * 0.01, sunDir, d);
            occluder = encodeOccluder(d);
        }
    }
    fragMask = vec4(lit, float(face + 1) / 255.0, plane / 255.0, occluder);

    float fade = smoothstep(AO_DISTANCE, AO_DISTANCE * 0.75, distance(pos, camPosition));
    if(fade <= 0.0) {
        fragAO = vec4(1.0);
        return;
    }
    float ao = traceAO(pos, face, p);
    bool aoFound = false;
    float previousAO = aoHistoryValid ? reusedAO(pos, face, plane, aoFound) : 1.0;
    ao = aoFound ? mix(previousAO, ao, AO_BLEND) : ao;
    fragAO = vec4(mix(1.0, ao, fade));
}
