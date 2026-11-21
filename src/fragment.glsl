#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;

uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // written by shadow_fragment.glsl at half resolution
uniform vec2 maskScale;       // mask size / screen size
uniform sampler2D halfDepth;  // depth of the half resolution pass
uniform vec2 depthRange;      // near and far planes
uniform float fogDensity;     // set from the view distance, so that chunks appear in the fog

in vec3 vAlbedo;
in float vAO;
in vec3 vPosition;
in vec3 vNormal;
flat in int vFace;

out vec4 fragColor;

@import ./shadow;
@import ./common;
@import ./clouds;
@import ./cloud_shading;
@import ./atmosphere;

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

// Shadow of this pixel from the half resolution mask: bilinear blend of the 4 nearest mask texels,
// keeping only the ones on the same face plane, so shadows never leak across voxel edges.
// x: terrain shadow, y: cloud shadow
vec2 maskShadow(vec3 toLight) {
    vec2 h = gl_FragCoord.xy * maskScale - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    ivec2 maxTexel = textureSize(shadowMask, 0) - 1;
    float plane = mod(floor(vPosition[vFace >> 1] + 0.5), 256.0);

    vec2 sum = vec2(0.0), anySum = vec2(0.0);
    float weightSum = 0.0, farthest = 0.0, anyWeight = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            ivec2 texel = clamp(base + ivec2(i, j), ivec2(0), maxTexel);
            vec4 m = texelFetch(shadowMask, texel, 0);
            farthest = max(farthest, texelFetch(halfDepth, texel, 0).r);
            float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
            anySum += m.ra * w;
            anyWeight += w;
            if(int(m.g * 255.0 + 0.5) - 1 == vFace && floor(m.b * 255.0 + 0.5) == plane) {
                sum += m.ra * w;
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
        if(dist > NEAR_FALLBACK || dist > linearDepth(farthest) * 1.0002 + 0.05) {
            return anySum / anyWeight;
        }
        return vec2(castShadowRay(rayStart(), toLight), anySum.y / anyWeight);
    }
    return sum / weightSum;
}

void main() {
    vec3 toLight = -lightDir;
    float ndotl = max(dot(vNormal, toLight), 0.0);

    // faces turned away from the light are in the shadow anyway: no ray
    float shadow = 0.0;
    if(ndotl > 0.0) {
        vec2 s = halfResShadows ? maskShadow(toLight) : vec2(castShadowRay(rayStart(), toLight), cloudShadow(vPosition, toLight));
        shadow = s.x * s.y; // terrain x clouds
    }

    // linear lighting: ambient from the sky (darkened by the occlusion) + sun or moon (only partly darkened by the
    // occlusion, so creases stay readable in the light)
    vec3 light = ambientLight(vNormal) * vAO + lightColor * ndotl * shadow * (0.5 + 0.5 * vAO);
    vec3 color = vAlbedo * light;

    vec3 toSurface = vPosition - camPosition;
    float dist = length(toSurface);
    vec3 viewDir = toSurface / dist;
    // light shafts, and the clouds in front when the camera is above them
    color += lightShaftsAt();
    if(camPosition.z > CLOUD_BOTTOM) {
        vec3 cloudNormal;
        ivec3 cloudCellHit;
        float t = traceClouds(camPosition, viewDir, dist, cloudNormal, cloudCellHit);
        if(t >= 0.0) color = mix(color, shadeCloud(viewDir, cloudNormal, cloudCellHit), exp(-t / CLOUD_FADE));
    }
    // valley mist, lit like the horizon in that direction
    float mist = 1.0 - exp(-mistDepth(camPosition, viewDir, dist));
    color = mix(color, skyRadiance(vec3(viewDir.xy, 0.0)), mist);
    // distance fog with the color of the sky behind the surface: far terrain melts into the horizon, and chunks
    // appear in the fog rather than at a visible edge
    float d2 = (dist * fogDensity) * (dist * fogDensity);
    float fog = 1.0 - exp(-d2 * d2 * d2); // clear up to half the view distance, thick close to it
    color = mix(color, skyRadiance(viewDir), fog);

    fragColor = vec4(toneMap(color), 1);
}
