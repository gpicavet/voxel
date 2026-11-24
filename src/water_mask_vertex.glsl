#version 300 es
precision highp float;

// Water faces seen from the camera, marked in the stencil of the reflection (main.js): only there is the reflection
// rendered. Same surface as water_vertex.glsl.
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 chunkOrigin;
uniform float seaLevel;

flat out int vFace;

void main() {
    vec3 p = chunkOrigin + vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    vFace = int((data >> 21) & 7u);
    if(p.z > seaLevel - 0.5) p.z = seaLevel - 0.12;
    gl_Position = viewProj * vec4(p, 1.0);
}
