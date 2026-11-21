#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;
precision mediump sampler2DArray;

// Water surface: waves, planar reflection of the scene (rendered mirrored below the water level), Fresnel, sun glint,
// and the ground seen through the water, dimmed with the depth (premultiplied alpha over the terrain already drawn).

uniform vec3 camPosition;
uniform float fogDensity;
uniform float waterTime;
uniform float seaLevel;
uniform sampler2D reflectionTex; // linear HDR, same screen coordinates as this pass
uniform bool reflectionOn;
uniform sampler2D halfDepth;     // depth of the terrain (half resolution), for the thickness of water
uniform bool hasHalfDepth;
uniform vec2 depthRange;
uniform sampler2DArray voxelNormals; // layer 5: normal map of the small waves

in vec3 vPosition;
flat in int vFace;
flat in vec3 vSkyUp;
flat in vec3 vAmbientUp;

out vec4 fragColor;

@import ./shadow;
@import ./common;
@import ./clouds;
@import ./atmosphere;

const vec3 ABSORPTION = vec3(0.45, 0.16, 0.12);   // per meter (lake water): red absorbed first, it turns blue-green
const vec3 SCATTERING = vec3(0.004, 0.020, 0.026); // light scattered back by the water body: deep water is dark blue-green

float linearDepth(float z) {
    return depthRange.x * depthRange.y / (depthRange.y - z * (depthRange.y - depthRange.x));
}

// gradient of the wave height: a few directional waves, and two scrolling layers of small waves (normal map) that break
// their regularity
vec2 waveSlope(vec2 p, float t, float dist) {
    vec2 g = vec2(0.0);
    const vec2 DIRS[5] = vec2[5](vec2(1.0, 0.2), vec2(0.6, 0.8), vec2(-0.3, 1.0), vec2(0.9, -0.5), vec2(-0.8, 0.6));
    const float LENGTHS[5] = float[5](11.0, 6.3, 3.7, 2.1, 1.3);
    for(int i = 0; i < 5; i++) {
        vec2 d = normalize(DIRS[i]);
        float k = 6.2831853 / LENGTHS[i];
        float w = sqrt(9.8 * k);
        float a = 0.012 * LENGTHS[i]; // steepness a k = 0.075
        g += d * a * k * cos(dot(d, p) * k + w * t + float(i) * 1.7);
    }
    vec3 n1 = texture(voxelNormals, vec3(p / 9.0 + t * vec2(0.020, 0.012), 5.0)).xyz * 2.0 - 1.0;
    vec3 n2 = texture(voxelNormals, vec3(p / 3.3 - t * vec2(0.035, 0.050), 5.0)).xyz * 2.0 - 1.0;
    g -= n1.xy / n1.z * 0.55 + n2.xy / n2.z * 0.3;
    // calmer far away: the waves are smaller than a pixel, they would only flicker
    return g / (1.0 + dist / 90.0);
}

void main() {
    vec3 toSurface = vPosition - camPosition;
    float dist = length(toSurface);
    vec3 viewDir = toSurface / dist;
    vec3 toLight = -lightDir;
    const vec3 NORMALS[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
    vec3 faceNormal = NORMALS[vFace];
    bool fromBelow = dot(viewDir, faceNormal) > 0.0;

    vec3 n = faceNormal;
    if(vFace == 4) {
        vec2 g = waveSlope(vPosition.xy, waterTime, dist);
        n = normalize(vec3(-g, 1.0));
    }
    if(fromBelow) n = -n;

    // thickness of water along the view ray, from the depth of the terrain behind
    float thickness = 8.0;
    if(hasHalfDepth && !fromBelow) {
        ivec2 size = textureSize(halfDepth, 0);
        float d = texelFetch(halfDepth, clamp(ivec2(gl_FragCoord.xy * vec2(size) / screenSize), ivec2(0), size - 1), 0).r;
        float zw = linearDepth(gl_FragCoord.z);
        thickness = d >= 1.0 ? 200.0 : max(linearDepth(d) - zw, 0.0) * dist / max(zw, 1e-3);
    }
    vec3 transmittance = exp(-ABSORPTION * thickness);
    float t = dot(transmittance, vec3(0.2, 0.5, 0.3));
    vec3 bodyLight = vAmbientUp + lightColor * max(toLight.z, 0.0);
    vec3 body = SCATTERING * bodyLight * (1.0 - transmittance) / max(1.0 - t, 1e-3); // color of the water itself

    vec3 color;
    float alpha;
    if(fromBelow) {
        // seen from under the water: the sky through Snell's window, total internal reflection outside it
        float window = smoothstep(0.62, 0.70, viewDir.z);
        color = mix(underwaterColor(), skyRadiance(refract(viewDir, n, 1.33)) * 0.8, window);
        color = mix(color, underwaterColor(), 1.0 - exp(-dist * max(underwaterDensity, 0.04)));
        alpha = 0.9;
    } else {
        float cosTheta = clamp(dot(-viewDir, n), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
        vec3 r = reflect(viewDir, n);
        r.z = abs(r.z);

        vec3 reflection;
        if(reflectionOn && vFace == 4) {
            vec2 uv = gl_FragCoord.xy / screenSize + n.xy * 0.045;
            reflection = texture(reflectionTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
        } else {
            reflection = skyRadiance(r);
        }

        // sun glint, shadowed by the terrain and the clouds (rays only where it matters)
        float spec = pow(max(dot(r, toLight), 0.0), 700.0) * 90.0;
        if(spec > 0.002) {
            spec *= cloudShadow(vPosition, toLight);
            if(spec > 0.05) spec *= castShadowRay(vPosition + vec3(0.0, 0.0, 0.05), toLight);
        }

        // premultiplied: what the water adds, and how much of the ground behind it lets through
        alpha = 1.0 - (1.0 - fresnel) * t;
        color = fresnel * reflection + lightColor * spec + (1.0 - fresnel) * (1.0 - t) * body;
    }

    // same atmosphere as the terrain at this distance: light shaft haze, valley mist, distance fog
    vec4 shafts = lightShaftsAt();
    color = mix(vSkyUp * 0.5 * alpha, color, shafts.a);
    float mist = 1.0 - exp(-mistDepth(camPosition, viewDir, dist));
    color = mix(color, skyRadiance(vec3(viewDir.xy, 0.0)) * alpha, mist);
    float d2 = (dist * fogDensity) * (dist * fogDensity);
    float fog = 1.0 - exp(-d2 * d2 * d2);
    color = mix(color, skyRadiance(viewDir) * alpha, fog);
    color += shafts.rgb * alpha;

    // blending happens on the tone mapped image: tone map the water as if opaque, then premultiply
    alpha = clamp(alpha, 0.0, 1.0);
    fragColor = vec4(toneMap(color / max(alpha, 1e-3)) * alpha, alpha);
}
