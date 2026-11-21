#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

uniform mat4 invViewProj;
uniform vec3 camPosition;
uniform vec3 moonDir;
uniform vec3 sunDiskColor;
uniform vec3 moonDiskColor;
uniform float starVisibility;

in vec2 vNdc;

out vec4 fragColor;

@import ./common;
@import ./clouds;
@import ./cloud_shading;
@import ./atmosphere;

float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}

// a few thousand stars: one possible star per cell of a grid on the directions
vec3 stars(vec3 dir) {
    vec3 cell = floor(dir * 300.0);
    float h = hash(cell);
    if(h < 0.997) return vec3(0.0);
    vec3 center = normalize(cell + 0.5 + (vec3(hash(cell + 1.0), hash(cell + 2.0), hash(cell + 3.0)) - 0.5) * 0.6);
    float d = length(dir * 300.0 - center * 300.0);
    float brightness = (h - 0.997) / 0.003;
    return vec3(0.9, 0.95, 1.0) * brightness * brightness * 0.08 * smoothstep(0.6, 0.0, d);
}

void main() {
    vec4 far = invViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w - camPosition);

    vec3 sky = skyRadiance(dir);
    if(dir.z > 0.0) {
        sky += sunDiskColor * smoothstep(0.99985, 0.99992, dot(dir, sunDir));
        sky += moonDiskColor * smoothstep(0.99990, 0.99994, dot(dir, moonDir));
        sky += stars(dir) * starVisibility;
    }
    // voxel clouds (opaque, melting into the sky far away), then the light shafts in front of them
    vec3 cloudNormal;
    ivec3 cloudCellHit;
    float t = traceClouds(camPosition, dir, 1e5, cloudNormal, cloudCellHit);
    if(t >= 0.0) sky = mix(sky, shadeCloud(dir, cloudNormal, cloudCellHit), exp(-t / CLOUD_FADE));
    sky += lightShaftsAt().rgb; // the sky already contains the scattering of the air: no dimming
    fragColor = vec4(toneMap(sky), 1.0);
}
