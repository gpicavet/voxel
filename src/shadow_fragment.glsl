#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;

// One shadow ray per half resolution pixel, written to the shadow mask read by the color pass:
// r = lit (1) or in the shadow (0), g = face direction + 1 (0 = sky), b = face plane coordinate modulo 256.
uniform sampler2D halfDepth;
uniform sampler2D halfFace;
uniform mat4 invViewProj;
uniform vec3 lightDir;
// temporal reuse
uniform sampler2D historyMask; // mask of the previous frame
uniform mat4 prevViewProj;
uniform int frameIndex;
uniform bool refreshAll;       // no usable history (first frame, resize, fast sun)

out vec4 fragMask;

@import ./shadow;

// The shadow of a surface point does not depend on the camera, and the sun moves slowly: the previous mask is
// reused where it shows the same face plane, all lit or all in the shadow (shadow edges are traced every frame,
// reprojecting them would move them by a pixel at each camera motion). Tiles of 8x8 pixels are traced again in turn (every pixel at least
// every REFRESH_PERIOD frames, so sun motion and destructions show up), and so are newly visible surfaces.
// Whole tiles keep the pixels traced together by the GPU coherent.
const int REFRESH_PERIOD = 8;

float reusedShadow(vec3 pos, int face, float plane, out bool found) {
    found = false;
    vec4 prev = prevViewProj * vec4(pos, 1.0);
    if(prev.w <= 0.0) return 0.0;
    vec2 uv = prev.xy / prev.w * 0.5 + 0.5;
    if(any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return 0.0;
    ivec2 size = textureSize(historyMask, 0);
    vec2 h = uv * vec2(size) - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    float sum = 0.0, weightSum = 0.0, lo = 1.0, hi = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            vec4 m = texelFetch(historyMask, clamp(base + ivec2(i, j), ivec2(0), size - 1), 0);
            if(int(m.g * 255.0 + 0.5) - 1 == face && floor(m.b * 255.0 + 0.5) == plane) {
                float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
                sum += m.r * w;
                weightSum += w;
                lo = min(lo, m.r);
                hi = max(hi, m.r);
            }
        }
    }
    found = weightSum > 0.0 && hi - lo < 0.5;
    return found ? sum / weightSum : 0.0;
}

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int face = int(texelFetch(halfFace, p, 0).r * 255.0 + 0.5) - 1;
    if(face < 0) {
        fragMask = vec4(1.0, 0.0, 0.0, 1.0); // sky
        return;
    }
    vec3 normal = NORMALS[face];
    vec3 sunDir = -lightDir;

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

    float lit = 0.0;
    if(dot(normal, sunDir) > 0.0) {
        bool found = false;
        bool refresh = refreshAll || ((p.x >> 3) + (p.y >> 3) * 3 + frameIndex) % REFRESH_PERIOD == 0;
        if(!refresh) {
            lit = reusedShadow(pos, face, plane, found);
        }
        if(!found) {
            lit = castShadowRay(pos + normal * 0.01, sunDir);
        }
    }
    fragMask = vec4(lit, float(face + 1) / 255.0, plane / 255.0, 1.0);
}
