#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;

// Soft shadows from one ray per pixel: the raw mask (shadow_fragment.glsl) blurred over the penumbra of the sun disk,
// as wide as the distance to the occluder times its diameter (sharp at the contact, soft far from it), like the
// shadows of the real sun. First the occluders of the shadowed texels around (as in percentage closer soft shadows),
// then the mean of the texels within the penumbra; only the texels of the same surface (face direction, face plane
// within a step of the terrain, depth). Written with the layout the color pass reads (maskShadow): r = lit, g = face
// direction + 1, b = face plane, a = light let through by the clouds (soft, cloud_shadow.glsl).
uniform sampler2D rawMask;
uniform sampler2D halfDepth;
uniform mat4 invViewProj;
uniform vec2 depthRange;  // near and far planes
uniform vec3 lightDir;
uniform float pixelAngle; // radians per texel

out vec4 fragColor;

@import ./shadow;
@import ./clouds;
@import ./cloud_shadow;

const float MAX_RADIUS = 10.0; // texels
const int TAPS = 16;

float linearDepth(float z) {
    return depthRange.x * depthRange.y / (depthRange.y - z * (depthRange.y - depthRange.x));
}

// taps on a golden angle spiral, within the unit disc
vec2 spiral(int i) {
    float r = sqrt((float(i) + 0.5) / float(TAPS)), a = float(i) * 2.39996;
    return r * vec2(cos(a), sin(a));
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(rawMask, 0);
    vec4 m = texelFetch(rawMask, p, 0);
    int face = int(m.g * 255.0 + 0.5) - 1;
    if(face < 0) {
        fragColor = vec4(1.0, 0.0, 0.0, 1.0); // sky
        return;
    }
    float depth = texelFetch(halfDepth, p, 0).r, z = linearDepth(depth);
    vec4 world = invViewProj * vec4((vec2(p) + 0.5) / vec2(size) * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    float cloud = cloudShadowSoft(world.xyz / world.w, -lightDir);
    float plane = floor(m.b * 255.0 + 0.5);

    // 1. occluders of the shadowed texels around
    float occluders = 0.0, count = 0.0;
    bool lit = m.r >= 0.5, dark = !lit;
    if(dark) {
        occluders = m.a * m.a * 2048.0;
        count = 1.0;
    }
    for(int i = 0; i < TAPS; i++) {
        ivec2 q = clamp(p + ivec2(round(spiral(i) * MAX_RADIUS)), ivec2(0), size - 1);
        vec4 t = texelFetch(rawMask, q, 0);
        float d = abs(floor(t.b * 255.0 + 0.5) - plane);
        if(int(t.g * 255.0 + 0.5) - 1 != face || min(d, 256.0 - d) > 2.0
            || abs(linearDepth(texelFetch(halfDepth, q, 0).r) - z) >= 0.04 * z + 0.5) continue;
        if(t.r < 0.5) {
            occluders += t.a * t.a * 2048.0;
            count += 1.0;
            dark = true;
        } else {
            lit = true;
        }
    }
    float radius = count > 0.0 ? min(MAX_RADIUS, occluders / count * 2.0 * SUN_RADIUS / (z * pixelAngle)) : 0.0;
    if(!(lit && dark) || radius < 0.7) {
        fragColor = vec4(m.r, m.g, m.b, cloud); // no penumbra here
        return;
    }

    // 2. mean over the penumbra
    float sum = m.r, weight = 1.0;
    for(int i = 0; i < TAPS; i++) {
        vec2 o = spiral(i);
        ivec2 q = clamp(p + ivec2(round(o * radius)), ivec2(0), size - 1);
        vec4 t = texelFetch(rawMask, q, 0);
        float d = abs(floor(t.b * 255.0 + 0.5) - plane);
        if(int(t.g * 255.0 + 0.5) - 1 != face || min(d, 256.0 - d) > 2.0
            || abs(linearDepth(texelFetch(halfDepth, q, 0).r) - z) >= 0.04 * z + 0.5) continue;
        float w = 1.0 - 0.6 * dot(o, o);
        sum += t.r * w;
        weight += w;
    }
    fragColor = vec4(sum / weight, m.g, m.b, cloud);
}
