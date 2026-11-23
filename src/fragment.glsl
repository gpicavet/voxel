#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;
precision mediump sampler2DArray;

uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // written by shadow_fragment.glsl at half resolution
uniform vec2 maskScale;       // mask size / screen size
uniform sampler2D aoMask;     // ray traced ambient occlusion, same texels as shadowMask
uniform sampler2D halfDepth;  // depth of the half resolution pass
uniform vec2 depthRange;      // near and far planes
uniform float fogDensity;     // set from the view distance, so that chunks appear in the fog
uniform sampler2DArray voxelAlbedo;  // textures.js: 0 earth, 1 rock, 2 grass, 3 snow, 4 sand
uniform bool reflectionPass;  // rendering the mirrored scene for the water: nothing below the water, no mist
uniform float seaLevel;
uniform sampler2DArray voxelNormals; // tangent space normal maps of the same layers

in float vAO;
in float vSkyLight;
in vec3 vPosition;
in vec3 vNormal;
flat in int vFace;
flat in int vMaterial;
in vec3 vLocal;

out vec4 fragColor;

@import ./shadow;
@import ./common;
@import ./clouds;
@import ./cloud_shading;
@import ./atmosphere;
@import ./surface_atmosphere;
@import ./tree_shadow;
@import ./canopy;

// start of the shadow ray: on the face plane (an integer coordinate: removes the interpolation error, which grows
// far from the origin), just in front of the face
vec3 rayStart() {
    vec3 p = vPosition;
    int axis = vFace >> 1;
    p[axis] = floor(p[axis] + 0.5);
    return p + vNormal * 0.01;
}

const float NEAR_FALLBACK = 40.0; // beyond, no fallback ray

float linearDepth(float z) {
    return depthRange.x * depthRange.y / (depthRange.y - z * (depthRange.y - depthRange.x));
}

// Shadow and occlusion of this pixel from the half resolution masks: bilinear blend of the 4 nearest texels,
// keeping only the ones on the same face plane, so they never leak across voxel edges.
// x: terrain shadow, y: cloud shadow, z: ambient occlusion. The shadow rays (fallback) only when needed.
vec3 maskShadow(vec3 toLight, bool needShadow) {
    vec2 h = gl_FragCoord.xy * maskScale - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    ivec2 maxTexel = textureSize(shadowMask, 0) - 1;
    float plane = mod(floor(vPosition[vFace >> 1] + 0.5), 256.0);

    vec3 sum = vec3(0.0), anySum = vec3(0.0);
    float weightSum = 0.0, farthest = 0.0, anyWeight = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            ivec2 texel = clamp(base + ivec2(i, j), ivec2(0), maxTexel);
            vec4 m = texelFetch(shadowMask, texel, 0);
            vec3 value = vec3(m.ra, texelFetch(aoMask, texel, 0).r);
            farthest = max(farthest, texelFetch(halfDepth, texel, 0).r);
            float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
            anySum += value * w;
            anyWeight += w;
            if(int(m.g * 255.0 + 0.5) - 1 == vFace && floor(m.b * 255.0 + 0.5) == plane) {
                sum += value * w;
                weightSum += w;
            }
        }
    }
    if(weightSum == 0.0) {
        // No mask texel on this face plane. Far away, voxel faces are smaller than a pixel and every face touching a
        // pixel runs this shader (antialiasing): the shadow of the neighbours is right enough there. A fragment behind
        // all the surfaces around it will be covered (overdraw): no ray either. Nearby, it is a silhouette or a thin
        // detail: trace the ray.
        float dist = linearDepth(gl_FragCoord.z);
        vec3 neighbours = anySum / anyWeight;
        if(!needShadow || dist > NEAR_FALLBACK || dist > linearDepth(farthest) * 1.0002 + 0.05) {
            return neighbours;
        }
        return vec3(castShadowRay(rayStart(), toLight), neighbours.yz);
    }
    return sum / weightSum;
}

const float TEXTURE_TILE = 4.0; // voxels covered by one texture: continuous across the blocks of a surface
// texture layer of the faces of each material: 0 earth, 1 rock, 2 grass (earth), 3 snow (rock), 4 sand, 5 grass on all
// faces, 6 snow on all faces
const float BASE_LAYER[8] = float[8](0.0, 1.0, 0.0, 1.0, 4.0, 2.0, 3.0, 1.0);

float noise1(float x) {
    float i = floor(x), f = fract(x);
    float a = fract(sin(i * 127.1) * 43758.5453), b = fract(sin((i + 1.0) * 127.1) * 43758.5453);
    return mix(a, b, f * f * (3.0 - 2.0 * f));
}

// on the side of a grass or snow voxel, 1 where the top material hangs over the side: an irregular fringe from the
// top of the voxel, with spikes (blades, snow crust)
float fringe(float u, float z, float depth) {
    float edge = 1.0 - depth * (0.75 + 0.35 * noise1(u * 3.0) + 0.25 * noise1(u * 17.0) + 0.35 * pow(noise1(u * 61.0), 3.0));
    float aa = fwidth(z) * 1.5;
    return smoothstep(edge - aa, edge + aa, fract(z));
}

// color and normal (world space) of the voxel face, from the textures of its material
void surface(out vec3 albedo, out vec3 normal) {
    // texture coordinates along the face, and the tangents they follow (the sides run with the height)
    vec2 uv = (vFace < 2 ? vLocal.yz : vFace < 4 ? vLocal.xz : vLocal.xy) / TEXTURE_TILE;
    vec3 tangent = vFace < 2 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 bitangent = vFace < 4 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    bool top = vFace == 4, bottom = vFace == 5;

    // layer below and layer on top: grass voxels (2) are earth under grass, snow voxels (3) rock under snow; the others
    // have one layer on all their faces (5 grass, 6 snow)
    float base = BASE_LAYER[vMaterial];
    bool covered = vMaterial == 2 || vMaterial == 3;
    float cover = vMaterial == 2 ? 2.0 : 3.0;
    float coverage = !covered || bottom ? 0.0 : top ? 1.0 : fringe(uv.x * TEXTURE_TILE, vLocal.z, vMaterial == 2 ? 0.22 : 0.32);

    vec4 a = texture(voxelAlbedo, vec3(uv, base)), n = texture(voxelNormals, vec3(uv, base));
    if(coverage > 0.0) {
        a = mix(a, texture(voxelAlbedo, vec3(uv, cover)), coverage);
        n = mix(n, texture(voxelNormals, vec3(uv, cover)), coverage);
    }
    // large scale variation, so that the repetition of the textures does not show over wide areas
    float variation = textureLod(cloudNoise, vec3(vPosition.xy / 97.0, 0.61), 0.0).g;
    albedo = a.rgb * (0.8 + 0.45 * variation);
    vec3 tn = n.xyz * 2.0 - 1.0;
    normal = normalize(tangent * tn.x + bitangent * tn.y + vNormal * tn.z);
}

void main() {
    if(reflectionPass && vPosition.z < seaLevel - 0.12) discard; // under the water: not in the reflection
    vec3 toLight = -lightDir;
    float ndotl = max(dot(vNormal, toLight), 0.0);
    vec3 albedo, normal;
    surface(albedo, normal);

    // faces turned away from the light are in the shadow anyway: no ray
    float shadow = 0.0, occlusion = 1.0;
    if(halfResShadows) {
        vec3 s = maskShadow(toLight, ndotl > 0.0);
        shadow = ndotl > 0.0 ? s.x * s.y : 0.0; // terrain x clouds
        occlusion = s.z;
    } else if(ndotl > 0.0) {
        shadow = castShadowRay(rayStart(), toLight) * cloudShadow(vPosition, toLight);
    }

    // shadows of the trees (shadow map)
    if(shadow > 0.0) shadow *= treeShadow(vPosition, vNormal);

    // linear lighting: ambient from the sky (darkened by the occlusion) + sun or moon (only partly darkened by the
    // occlusion, so creases stay readable in the light); the relief of the textures (normal map) catches the light,
    // the shadows follow the voxel faces
    // sky light: the sky only lights what it reaches (Minecraft-like propagation, 0.8 per voxel: caves are dark)
    float skyAccess = 0.02 + 0.98 * pow(0.8, (1.0 - vSkyLight) * 15.0);
    // ambient occlusion: the 3 voxels of the corner (vertices, sharp contact) and the voxels within 10 (ray traced)
    // and the foliage of the trees above and around (canopy map)
    occlusion *= 1.0 - canopyOcclusion(vPosition, false);
    vec3 light = ambientLight(normal) * vAO * occlusion * skyAccess
        + lightColor * max(dot(normal, toLight), 0.0) * shadow * (0.5 + 0.5 * vAO) * (1.0 - 0.45 * trunkContact(vPosition));
    vec3 color = albedo * light;

    color = applyAtmosphere(color, vPosition);

    fragColor = vec4(toneMap(color), 1);
}
