#version 300 es

// x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (2 bits)
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 chunkOrigin;

out vec3 vAlbedo;
out float vAO;
out vec3 vPosition;
out vec3 vNormal;
flat out int vFace;

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

// sRGB, converted to linear below
const vec3 MATERIALS[4] = vec3[4](
    vec3(0.52, 0.40, 0.28),  // earth
    vec3(0.40, 0.40, 0.42),  // rock: darker than the snow, even in the sun
    vec3(0.30, 0.62, 0.18),  // grass
    vec3(0.92, 0.94, 0.97)); // snow

const float AO[4] = float[4](0.25, 0.5, 0.75, 1.0);

void main() {
    vec3 local = vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    int face = int((data >> 21) & 7u);
    int ao = int((data >> 24) & 3u);
    int material = int((data >> 26) & 3u);

    vPosition = chunkOrigin + local;
    vNormal = NORMALS[face];
    vFace = face;
    vAlbedo = pow(MATERIALS[material], vec3(2.2));
    vAO = AO[ao];
    gl_Position = viewProj * vec4(vPosition, 1.0);
}
