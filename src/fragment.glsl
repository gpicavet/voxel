#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;

uniform vec3 lightDir; // Direction de la lumière (normalisée)
uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // written by shadow_fragment.glsl at half resolution
uniform vec2 maskScale;       // mask size / screen size

in vec3 vAlbedo;
in float vAO;
in vec3 vPosition;
in vec3 vNormal;
flat in int vFace;

out vec4 fragColor;

@import ./shadow;
@import ./common;

const float FOG_DENSITY = 1.0 / 450.0;

// Shadow of this pixel from the half resolution mask: bilinear blend of the 4 nearest mask texels,
// keeping only the ones on the same face plane, so shadows never leak across voxel edges.
float maskShadow(vec3 sunDir) {
    vec2 h = gl_FragCoord.xy * maskScale - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    ivec2 maxTexel = textureSize(shadowMask, 0) - 1;
    float plane = mod(floor(vPosition[vFace >> 1] + 0.5), 256.0);

    float sum = 0.0, weightSum = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            vec4 m = texelFetch(shadowMask, clamp(base + ivec2(i, j), ivec2(0), maxTexel), 0);
            if(int(m.g * 255.0 + 0.5) - 1 == vFace && floor(m.b * 255.0 + 0.5) == plane) {
                float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
                sum += m.r * w;
                weightSum += w;
            }
        }
    }
    // no mask texel on this surface (detail thinner than 2 pixels, silhouette): trace this pixel
    if(weightSum == 0.0) {
        return castShadowRay(vPosition + vNormal * 1e-3, sunDir);
    }
    return sum / weightSum;
}

void main() {
    vec3 sunDir = -lightDir;
    float ndotl = max(dot(vNormal, sunDir), 0.0);

    // faces turned away from the sun are in the shadow anyway: no ray
    float shadow = 0.0;
    if(ndotl > 0.0) {
        shadow = halfResShadows ? maskShadow(sunDir) : castShadowRay(vPosition + vNormal * 1e-3, sunDir);
    }

    // linear lighting: ambient (darkened by the occlusion) + sun (only partly, so creases stay readable in the light)
    vec3 light = ambientLight(vNormal) * vAO + SUN_COLOR * ndotl * shadow * (0.5 + 0.5 * vAO);
    vec3 color = vAlbedo * light;

    // fog takes the color of the sky behind the surface, so far terrain melts into the horizon
    vec3 toSurface = vPosition - camPosition;
    float dist = length(toSurface);
    float fog = 1.0 - exp(-(dist * FOG_DENSITY) * (dist * FOG_DENSITY));
    color = mix(color, skyColor(toSurface / dist, sunDir), fog);

    fragColor = vec4(toneMap(color), 1);
}
