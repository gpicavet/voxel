#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;

uniform vec3 camPosition;
uniform bool halfResShadows;
uniform sampler2D shadowMask; // written by shadow_fragment.glsl at half resolution
uniform vec2 maskScale;       // mask size / screen size
uniform float fogDensity;     // set from the view distance, so that chunks appear in the fog

in vec3 vAlbedo;
in float vAO;
in vec3 vPosition;
in vec3 vNormal;
flat in int vFace;

out vec4 fragColor;

@import ./shadow;
@import ./common;

// start of the shadow ray: on the face plane (an integer coordinate: removes the interpolation error, which grows
// far from the origin), just in front of the face
vec3 rayStart() {
    vec3 p = vPosition;
    int axis = vFace >> 1;
    p[axis] = floor(p[axis] + 0.5);
    return p + vNormal * 0.01;
}

// Shadow of this pixel from the half resolution mask: bilinear blend of the 4 nearest mask texels,
// keeping only the ones on the same face plane, so shadows never leak across voxel edges.
float maskShadow(vec3 toLight) {
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
        return castShadowRay(rayStart(), toLight);
    }
    return sum / weightSum;
}

void main() {
    vec3 toLight = -lightDir;
    float ndotl = max(dot(vNormal, toLight), 0.0);

    // faces turned away from the light are in the shadow anyway: no ray
    float shadow = 0.0;
    if(ndotl > 0.0) {
        shadow = halfResShadows ? maskShadow(toLight) : castShadowRay(rayStart(), toLight);
    }

    // linear lighting: ambient from the sky (darkened by the occlusion) + sun or moon (only partly darkened by the
    // occlusion, so creases stay readable in the light)
    vec3 light = ambientLight(vNormal) * vAO + lightColor * ndotl * shadow * (0.5 + 0.5 * vAO);
    vec3 color = vAlbedo * light;

    vec3 toSurface = vPosition - camPosition;
    float dist = length(toSurface);
    vec3 viewDir = toSurface / dist;
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
