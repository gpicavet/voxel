// Canopy map (canopy.js): part of the sky hidden by the foliage of the trees above and around a point.
precision highp sampler2D;
uniform sampler2D canopyTex;  // per 1 m cell: density x crown bottom, density x crown top, density, trunk contact
uniform vec2 canopyOrigin;    // world xy of the map corner
uniform float canopySize;     // meters
uniform bool canopyOn;

// part of the sky hidden at height z by the foliage of a cell (or of the average cell of a mip level)
float canopyAbove(vec4 c, float z) {
    if(c.b < 1e-3) return 0.0;
    float bottom = c.r / c.b, top = c.g / c.b;
    return c.b * clamp((top - max(z, bottom)) / max(top - bottom, 1.0), 0.0, 1.0);
}

// onTree: the crown of the tree itself is in its baked openness, only the forest around counts
float canopyOcclusion(vec3 p, bool onTree) {
    if(!canopyOn) return 0.0;
    vec2 uv = (p.xy - canopyOrigin) / canopySize;
    if(any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
    vec2 edge = min(uv, 1.0 - uv);
    float fade = smoothstep(0.0, 0.06, min(edge.x, edge.y));
    vec4 forest = textureLod(canopyTex, uv, 4.0); // 16 m around: the forest
    float occlusion = canopyAbove(forest, p.z) * (onTree ? 0.4 : 0.65);
    if(!onTree) {
        vec4 near = textureLod(canopyTex, uv, 0.0);
        occlusion = max(occlusion, canopyAbove(near, p.z) * 0.8);
        // the ground right around a trunk, under its crown
        float bottom = near.b > 1e-3 ? near.r / near.b : 1e9;
        if(p.z < bottom) occlusion = max(occlusion, near.a * 0.55);
    }
    return occlusion * fade;
}
