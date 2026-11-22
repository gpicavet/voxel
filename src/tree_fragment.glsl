#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;

uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // half resolution mask: tree texels have the face id 7
uniform vec2 maskScale;
uniform float fogDensity;
uniform bool reflectionPass;
uniform float seaLevel;

in vec3 vPosition;
in vec3 vNormal;
in vec3 vLocal;
flat in vec3 vLocalNormal;
in float vAO;
flat in int vMaterial;
flat in float vTint;
flat in float vSkyLight;

out vec4 fragColor;

@import ./shadow;
@import ./common;
@import ./clouds;
@import ./cloud_shading;
@import ./atmosphere;
@import ./surface_atmosphere;
@import ./tree_shadow;

const int TREE_FACE = 7;
const float NEAR_FALLBACK = 40.0;

// sRGB colors of the materials of treeModels.js
const vec3 COLORS[7] = vec3[7](
    vec3(0.33, 0.24, 0.16),  // bark
    vec3(0.21, 0.38, 0.11),  // oak leaves
    vec3(0.82, 0.80, 0.74),  // birch bark
    vec3(0.10, 0.26, 0.12),  // pine needles
    vec3(0.42, 0.38, 0.33),  // dead wood
    vec3(0.34, 0.47, 0.15),  // birch leaves
    vec3(0.18, 0.34, 0.09)); // bush leaves

float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 albedo(bool leaf) {
    vec3 voxel = floor(vLocal - vLocalNormal * 0.5);
    float h = hash(voxel);
    vec3 color = COLORS[vMaterial];
    if(vMaterial == 2) {
        // birch: dark marks on the white bark
        if(hash(vec3(voxel.z, floor(voxel.x / 2.0), 7.0)) < 0.14) color = vec3(0.16, 0.15, 0.14);
    } else if(vMaterial == 0 || vMaterial == 4) {
        // bark: vertical streaks
        color *= 0.8 + 0.35 * hash(vec3(voxel.xy, 3.0));
    }
    color *= 0.82 + 0.36 * h;
    if(leaf) {
        // every tree a bit different: from fresh green to yellowish, lighter or darker
        color = mix(color, color * vec3(1.25, 1.08, 0.7), vTint * 0.4) * (0.88 + 0.24 * vTint);
    }
    return pow(color, vec3(2.2));
}

// terrain and cloud shadow of this tree pixel, from the half resolution mask (texels of trees only)
vec2 maskShadow(vec3 toLight) {
    vec2 h = gl_FragCoord.xy * maskScale - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    ivec2 maxTexel = textureSize(shadowMask, 0) - 1;
    vec2 sum = vec2(0.0);
    float weightSum = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            vec4 m = texelFetch(shadowMask, clamp(base + ivec2(i, j), ivec2(0), maxTexel), 0);
            if(int(m.g * 255.0 + 0.5) - 1 == TREE_FACE) {
                float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
                sum += m.ra * w;
                weightSum += w;
            }
        }
    }
    if(weightSum > 0.0) return sum / weightSum;
    // thin branch or edge of a crown, not in the mask: trace nearby, assume lit far away
    if(distance(vPosition, camPosition) > NEAR_FALLBACK) return vec2(1.0, cloudShadow(vPosition, toLight));
    return vec2(castShadowRay(vPosition + toLight * 0.3, toLight), cloudShadow(vPosition, toLight));
}

void main() {
    if(reflectionPass && vPosition.z < seaLevel - 0.12) discard;
    vec3 toLight = -lightDir;
    bool leaf = vMaterial == 1 || vMaterial == 3 || vMaterial == 5 || vMaterial == 6;
    vec3 n = normalize(vNormal);
    float ndotl = dot(n, toLight);
    // leaves let some light through: lit a little from behind too
    float diffuse = leaf ? clamp(ndotl * 0.7 + 0.3, 0.0, 1.0) : max(ndotl, 0.0);

    float shadow = 0.0;
    if(diffuse > 0.0 && toLight.z > 0.0) {
        vec2 s = halfResShadows ? maskShadow(toLight)
            : vec2(castShadowRay(vPosition + toLight * 0.3, toLight), cloudShadow(vPosition, toLight));
        shadow = s.x * s.y * treeShadow(vPosition, n);
    }
    float skyAccess = 0.02 + 0.98 * pow(0.8, (1.0 - vSkyLight) * 15.0);
    vec3 light = ambientLight(n) * vAO * skyAccess + lightColor * diffuse * shadow;
    vec3 color = albedo(leaf) * light;
    fragColor = vec4(toneMap(applyAtmosphere(color, vPosition)), 1.0);
}
