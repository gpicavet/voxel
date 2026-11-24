#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;
precision mediump sampler2DArray;

uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // half resolution mask: tree texels have the face id 7
uniform vec2 maskScale;
uniform float fogDensity;
uniform bool reflectionPass;
uniform bool reflectionMask;  // in the reflection, the shadows of the camera's mask where it sees the same tree
uniform mat4 mainViewProj;    // the camera (not mirrored)
uniform sampler2D halfDepth;  // depth of the half resolution pass
uniform vec2 depthRange;      // near and far planes
uniform float seaLevel;

in vec3 vPosition;
in vec3 vRestPosition;
in vec3 vNormal;
in vec3 vLocal;
flat in vec3 vLocalNormal;
in float vAO;
flat in int vMaterial;
flat in int vVariant;
in vec3 vFringe;
flat in float vTint;
flat in float vSkyLight;
flat in float vYaw;
in float vOpenness;
in float vHeight;

out vec4 fragColor;

@import ./shadow;
@import ./common;
@import ./clouds;
@import ./cloud_shading;
@import ./atmosphere;
@import ./surface_atmosphere;
@import ./tree_shadow;
@import ./tree_surface;
@import ./canopy;
@import ./reflection_mask;

const int TREE_FACE = 7;
const float NEAR_FALLBACK = 40.0;

float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(vec3(i, 0.0)), hash(vec3(i + vec2(1.0, 0.0), 0.0)), f.x),
        mix(hash(vec3(i + vec2(0.0, 1.0), 0.0)), hash(vec3(i + vec2(1.0), 0.0)), f.x), f.y);
}

const vec3 MOSS_COLOR = vec3(0.075, 0.13, 0.03);

// moss cover (0 .. 1) of a bark face at uv (meters): on the faces turned to the north (+y, the sun culminates towards -y),
// in patches with ragged edges, thicker low on the trunk where it is damp
float moss(vec2 uv) {
    float c = cos(vYaw), s = sin(vYaw);
    float north = smoothstep(0.2, 0.9, s * vLocalNormal.x + c * vLocalNormal.y); // y of the world normal
    if(north <= 0.0) return 0.0;
    float low = 1.0 - smoothstep(1.0, 7.0, vLocal.z * voxelSize); // meters above the base of the model
    float patches = valueNoise(uv * 2.5) * 0.7 + valueNoise(uv * 9.0) * 0.3;
    float edge = 0.62 - 0.3 * low;
    return north * smoothstep(edge - 0.06, edge + 0.06, patches);
}

// color (linear) and normal (world) of the fragment, from the textures; per tree and per voxel variations
void treeSurface(bool leaf, out vec3 albedo, out vec3 normal) {
    vec3 texel = treeTexel(vMaterial, vVariant, vLocal, vLocalNormal, vTint * 7.0, vPosition, vFringe).rgb;
    albedo = texel;
    vec3 tn = vec3(0.0, 0.0, 1.0); // the pixel art foliage is flat
    if(leaf) {
        // every tree a bit different: from fresh green to yellowish (not the blossoms), lighter or darker
        if(vMaterial != 7) albedo = mix(albedo, albedo * vec3(1.25, 1.08, 0.7), vTint * 0.4);
        albedo *= 0.88 + 0.24 * vTint;
    } else {
        // bark: a little per voxel, so the voxels still read, and the relief of the texture
        albedo *= 0.94 + 0.12 * hash(floor(vLocal - vLocalNormal * 0.5));
        vec2 uv = treeUV(vLocal, vLocalNormal, vTint * 7.0);
        tn = texture(voxelNormals, vec3(uv, float(BARK_LAYERS[vMaterial]))).xyz * 2.0 - 1.0;
        // moss on the faces turned to the north, flattening the relief of the bark
        float m = moss(uv);
        if(m > 0.0) {
            // tufts: a fine grain, faded out where it gets smaller than the pixels (it would shimmer)
            float grain = (valueNoise(uv * 48.0) - 0.5) * (1.0 - smoothstep(0.3, 1.0, fwidth(uv.x * 48.0)));
            albedo = mix(albedo, MOSS_COLOR * (0.75 + 0.5 * valueNoise(uv * 11.0) + 0.5 * grain), m);
        }
        tn = normalize(mix(tn, vec3(0.0, 0.0, 1.0), m * 0.7));
    }
    vec3 n = vLocalNormal;
    vec3 t = abs(n.x) > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 b = abs(n.z) > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
    vec3 local = normalize(t * tn.x + b * tn.y + n * tn.z);
    float c = cos(vYaw), s = sin(vYaw);
    normal = vec3(c * local.x - s * local.y, s * local.x + c * local.y, local.z);
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
    bool leaf = isLeaf(vMaterial);
    vec3 albedo, n;
    treeSurface(leaf, albedo, n);
    float ndotl = dot(n, toLight);
    // leaves let some light through: lit a little from behind too
    float diffuse = leaf ? clamp(ndotl * 0.7 + 0.3, 0.0, 1.0) : max(ndotl, 0.0);

    float shadow = 0.0;
    if(diffuse > 0.0 && toLight.z > 0.0) {
        vec2 s;
        if(halfResShadows) {
            s = maskShadow(toLight);
        } else {
            // in the reflection, from the camera's mask where it sees this tree too; a ray elsewhere
            s = reflectionMask ? cameraMaskShadow(vPosition, TREE_FACE, -1.0) : vec2(-1.0);
            if(s.x < 0.0) s = vec2(castShadowRay(vPosition + toLight * 0.3, toLight), cloudShadow(vPosition, toLight));
        }
        shadow = s.x * s.y * treeShadow(vRestPosition, n);
    }
    float skyAccess = 0.02 + 0.98 * pow(0.8, (1.0 - vSkyLight) * 15.0);
    // ambient occlusion: the tree itself (baked: inside and under the crown, corners of the voxels), the ground at its
    // foot, and the forest around (canopy map); half of it on the direct light too, so that it shows in the sun
    float foot = mix(0.45, 1.0, smoothstep(0.0, 1.5, vHeight));
    float self = mix(0.2, 1.0, vOpenness) * vAO * foot;
    float occlusion = self * (1.0 - canopyOcclusion(vRestPosition, true));
    vec3 light = ambientLight(n) * occlusion * skyAccess + lightColor * diffuse * shadow * mix(1.0, self, 0.5);
    vec3 color = albedo * light;
    fragColor = vec4(toneMap(applyAtmosphere(color, vPosition)), 1.0);
}
