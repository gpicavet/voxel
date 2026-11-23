// Shadows cast by the trees: two depth maps rendered from the sun (or the moon) around the camera, for the light at the
// start and at the end of a short step of its course, blended with the current time (main.js): continuous motion,
// each map still. Beyond them, a much larger map of the coarsest models gives simplified shadows far away.
precision highp sampler2DShadow;
uniform sampler2DShadow treeShadowMap;  // A
uniform sampler2DShadow treeShadowMapB; // B
uniform mat4 treeShadowMatrix;          // world -> light clip space of A (orthographic)
uniform mat4 treeShadowMatrixB;
uniform float treeShadowBlend;          // 0: A .. 1: B
uniform bool treeShadowOn;
uniform sampler2DShadow treeShadowFar;  // far map, coarsest models
uniform mat4 treeShadowFarMatrix;
uniform bool treeShadowFarOn;

// light let through by the trees at p in one map (1 = no tree in the way), 4 bilinear comparisons; y: how much the map
// covers p (fading out at its border)
vec2 treeShadowIn(sampler2DShadow map, mat4 matrix, vec3 p, float bias) {
    vec3 c = (matrix * vec4(p, 1.0)).xyz * 0.5 + 0.5;
    if(any(lessThan(c, vec3(0.0))) || any(greaterThan(c, vec3(1.0)))) return vec2(1.0, 0.0);
    vec2 texel = 1.0 / vec2(textureSize(map, 0));
    float depth = c.z - bias;
    float lit = 0.25 * (texture(map, vec3(c.xy + vec2(-0.5, -0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(0.5, -0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(-0.5, 0.5) * texel, depth))
        + texture(map, vec3(c.xy + vec2(0.5, 0.5) * texel, depth)));
    vec2 edge = min(c.xy, 1.0 - c.xy);
    return vec2(lit, smoothstep(0.0, 0.05, min(edge.x, edge.y)));
}

float treeShadow(vec3 p, vec3 normal) {
    if(!treeShadowOn) return 1.0;
    vec3 q = p + normal * 0.06;
    // near maps A and B, blended
    vec2 near = vec2(1.0, 0.0);
    if(treeShadowBlend < 0.999) near = treeShadowIn(treeShadowMap, treeShadowMatrix, q, 0.0008);
    if(treeShadowBlend > 0.001) near = mix(near, treeShadowIn(treeShadowMapB, treeShadowMatrixB, q, 0.0008), treeShadowBlend);
    if(near.y >= 1.0 || !treeShadowFarOn) return mix(1.0, near.x, near.y);
    // beyond them: the far map (larger texels: larger offsets)
    vec2 far = treeShadowIn(treeShadowFar, treeShadowFarMatrix, p + normal * 0.3, 0.0004);
    return mix(mix(1.0, far.x, far.y), near.x, near.y);
}
