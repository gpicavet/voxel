#version 300 es
precision highp float;
precision highp sampler3D;

// Light let through by the clouds towards the light, per texel of a square area around the camera, at the bottom of the
// clouds: a ground point p reads it where the ray from p to the light enters the clouds (cloud_shadow.glsl). The part of
// each cell under the texel is exact, so the shadows glide with the wind instead of jumping by texels; then blurred
// (penumbra, blur_fragment.glsl). Each layer of cloud lets through 30 %.
uniform vec3 toLight;
uniform vec3 cloudShadowArea; // world xy of the corner, size
uniform float texels;         // per side

out vec4 fragColor;

@import ./clouds;

void main() {
    float w = cloudShadowArea.z / texels;
    vec2 corner = cloudShadowArea.xy + floor(gl_FragCoord.xy) * w;
    vec2 slope = toLight.xy / toLight.z;
    float wc = w / CLOUD_CELL.x; // texel size in cells (smaller than a cell)
    float light = 1.0;
    for(int k = 0; k < CLOUD_LAYERS; k++) {
        float z = CLOUD_BOTTOM + (float(k) + 0.5) * CLOUD_CELL.z;
        vec2 a = (corner + slope * (z - CLOUD_BOTTOM) - WIND * cloudTime) / CLOUD_CELL.xy;
        ivec2 c = ivec2(floor(a));
        vec2 f = a - vec2(c);
        // the texel [a, a + wc] overlaps at most 2 x 2 cells
        vec2 first = min(vec2(1.0), f + wc) - f, second = max(vec2(0.0), f + wc - 1.0);
        float covered = 0.0;
        if(cloudCell(ivec3(c, k))) covered += first.x * first.y;
        if(second.x > 0.0 && cloudCell(ivec3(c + ivec2(1, 0), k))) covered += second.x * first.y;
        if(second.y > 0.0 && cloudCell(ivec3(c + ivec2(0, 1), k))) covered += first.x * second.y;
        if(second.x > 0.0 && second.y > 0.0 && cloudCell(ivec3(c + ivec2(1, 1), k))) covered += second.x * second.y;
        light *= 1.0 - 0.7 * covered / (wc * wc);
    }
    fragColor = vec4(max(light, 0.15), 0.0, 0.0, 1.0);
}
