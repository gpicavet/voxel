// Shadows cast by the trees: a depth map rendered from the sun (or the moon) around the camera (main.js).
precision highp sampler2DShadow;
uniform sampler2DShadow treeShadowMap;
uniform mat4 treeShadowMatrix; // world -> light clip space (orthographic)
uniform bool treeShadowOn;

// light let through by the trees at p (1 = no tree in the way); 4 bilinear comparisons
float treeShadow(vec3 p, vec3 normal) {
    if(!treeShadowOn) return 1.0;
    vec3 c = (treeShadowMatrix * vec4(p + normal * 0.06, 1.0)).xyz * 0.5 + 0.5;
    if(any(lessThan(c, vec3(0.0))) || any(greaterThan(c, vec3(1.0)))) return 1.0;
    vec2 texel = 1.0 / vec2(textureSize(treeShadowMap, 0));
    float depth = c.z - 0.0008;
    float lit = 0.25 * (texture(treeShadowMap, vec3(c.xy + vec2(-0.5, -0.5) * texel, depth))
        + texture(treeShadowMap, vec3(c.xy + vec2(0.5, -0.5) * texel, depth))
        + texture(treeShadowMap, vec3(c.xy + vec2(-0.5, 0.5) * texel, depth))
        + texture(treeShadowMap, vec3(c.xy + vec2(0.5, 0.5) * texel, depth)));
    // fade out at the border of the map
    vec2 edge = min(c.xy, 1.0 - c.xy);
    return mix(1.0, lit, smoothstep(0.0, 0.05, min(edge.x, edge.y)));
}
