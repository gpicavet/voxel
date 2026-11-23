// Shadows cast by the trees: two depth maps rendered from the sun (or the moon) around the camera, for the light at the
// start and at the end of a short step of its course, blended with the current time (main.js): continuous motion,
// each map still.
precision highp sampler2DShadow;
uniform sampler2DShadow treeShadowMap;  // A
uniform sampler2DShadow treeShadowMapB; // B
uniform mat4 treeShadowMatrix;          // world -> light clip space of A (orthographic)
uniform mat4 treeShadowMatrixB;
uniform float treeShadowBlend;          // 0: A .. 1: B
uniform bool treeShadowOn;

// light let through by the trees at p in one map (1 = no tree in the way); 4 bilinear comparisons
float treeShadowIn(sampler2DShadow map, mat4 matrix, vec3 p) {
    vec3 c = (matrix * vec4(p, 1.0)).xyz * 0.5 + 0.5;
    if(any(lessThan(c, vec3(0.0))) || any(greaterThan(c, vec3(1.0)))) return 1.0;
    vec2 texel = 1.0 / vec2(textureSize(map, 0));
    float depth = c.z - 0.0008;
    float lit = 0.25 * (texture(map, vec3(c.xy + vec2(-0.5, -0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(0.5, -0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(-0.5, 0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(0.5, 0.5) * texel, depth)));
    // fade out at the border of the map
    vec2 edge = min(c.xy, 1.0 - c.xy);
    return mix(1.0, lit, smoothstep(0.0, 0.05, min(edge.x, edge.y)));
}

float treeShadow(vec3 p, vec3 normal) {
    if(!treeShadowOn) return 1.0;
    p += normal * 0.06;
    float a = treeShadowBlend < 0.999 ? treeShadowIn(treeShadowMap, treeShadowMatrix, p) : 1.0;
    float b = treeShadowBlend > 0.001 ? treeShadowIn(treeShadowMapB, treeShadowMatrixB, p) : 1.0;
    return mix(a, b, treeShadowBlend);
}
