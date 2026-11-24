// In the reflection of the water: the shadows of the camera's half resolution mask (shadow_fragment.glsl) for a surface
// the camera sees too, instead of a ray per pixel. Needs the uniforms shadowMask, halfDepth, depthRange and
// mainViewProj (the camera, not mirrored) of the including shader.
// face: face id of the mask texels to use (a terrain face, or the trees); plane: face plane (mod 256), or -1 for any.
// Returns (terrain shadow, cloud shadow), or (-1, -1) when the camera does not see this point.
vec2 cameraMaskShadow(vec3 position, int face, float plane) {
    vec4 clip = mainViewProj * vec4(position, 1.0);
    if(clip.w <= 0.0) return vec2(-1.0);
    vec3 ndc = clip.xyz / clip.w;
    if(abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) return vec2(-1.0);
    ivec2 size = textureSize(shadowMask, 0);
    vec2 h = (ndc.xy * 0.5 + 0.5) * vec2(size) - 0.5;
    vec2 f = fract(h);
    ivec2 base = ivec2(floor(h));
    float n = depthRange.x, fa = depthRange.y;
    float depth = n * fa / (fa - (ndc.z * 0.5 + 0.5) * (fa - n));
    vec2 sum = vec2(0.0);
    float weightSum = 0.0;
    for(int j = 0; j <= 1; j++) {
        for(int i = 0; i <= 1; i++) {
            ivec2 texel = clamp(base + ivec2(i, j), ivec2(0), size - 1);
            vec4 m = texelFetch(shadowMask, texel, 0);
            if(int(m.g * 255.0 + 0.5) - 1 != face || (plane >= 0.0 && floor(m.b * 255.0 + 0.5) != plane)) continue;
            float d = n * fa / (fa - texelFetch(halfDepth, texel, 0).r * (fa - n));
            if(abs(d - depth) > 0.5 + 0.02 * depth) continue; // another surface of the same plane, in front
            float w = max(mix(1.0 - f.x, f.x, float(i)) * mix(1.0 - f.y, f.y, float(j)), 1e-3);
            sum += m.ra * w;
            weightSum += w;
        }
    }
    return weightSum > 0.0 ? sum / weightSum : vec2(-1.0);
}
