#version 300 es

// x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (2 bits)
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 chunkOrigin;

out vec3 vColor;
out vec3 vPosition;
out vec3 vNormal;

// the depth pre-pass and the color pass must produce exactly the same depth
invariant gl_Position;

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

const vec3 MATERIALS[3] = vec3[3](
    vec3(0.5, 0.4, 0.3),  // earth
    vec3(0.5, 0.5, 0.5),  // rock
    vec3(0.1, 1.0, 0.2)); // grass

const float AO[4] = float[4](0.25, 0.5, 0.75, 1.0);

void main() {
    vec3 local = vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    int face = int((data >> 21) & 7u);
    int ao = int((data >> 24) & 3u);
    int material = int((data >> 26) & 3u);

    vPosition = chunkOrigin + local;
    vNormal = NORMALS[face];
    vColor = MATERIALS[material] * AO[ao];
    gl_Position = viewProj * vec4(vPosition, 1.0);
}
