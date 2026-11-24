#version 300 es
precision highp float;
precision highp sampler2D;

// Keeps the top faces of the water that are in front of the terrain and the trees of the depth pre-pass, here or a few
// pixels around (the waves read the reflection a little aside, water_fragment.glsl). Only the stencil is written.
uniform sampler2D halfDepth; // depth pre-pass, same view
uniform vec2 targetSize;     // pixels of the reflection target

flat in int vFace;
out vec4 fragColor;

void main() {
    if(vFace != 4) discard;
    ivec2 size = textureSize(halfDepth, 0);
    vec2 scale = vec2(size) / targetSize;
    for(int ring = 0; ring < 4; ring++) {
        float radius = float(ring) * 4.0;
        for(int k = 0; k < 8; k++) {
            if(ring == 0 && k > 0) break;
            float a = float(k) * 0.785398;
            ivec2 p = ivec2((gl_FragCoord.xy + radius * vec2(cos(a), sin(a))) * scale);
            if(gl_FragCoord.z <= texelFetch(halfDepth, clamp(p, ivec2(0), size - 1), 0).r) {
                fragColor = vec4(0.0);
                return;
            }
        }
    }
    discard;
}
