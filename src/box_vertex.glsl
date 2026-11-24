#version 300 es

// Boxes of the occlusion tests (world.js): the unit cube of the chunk boxes (packed vertex, corners 0 or 1), moved and
// stretched. Nothing is written: only whether a sample passes the depth test counts.
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 boxMin;
uniform vec3 boxSize;

void main() {
    vec3 corner = vec3(float(data & 1u), float((data >> 7) & 1u), float((data >> 14) & 1u));
    gl_Position = viewProj * vec4(boxMin + corner * boxSize, 1.0);
}
