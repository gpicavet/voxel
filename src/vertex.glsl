#version 300 es

// x, y, z in the chunk (7 bits each) | face direction (3 bits) | ambient occlusion (2 bits) | material (3 bits)
// | sky light (3 bits)
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 chunkOrigin;
uniform float chunkScale; // 2 for the coarse meshes of the far chunks (positions in voxels twice as large)

out float vAO;
out float vSkyLight; // 0 (no sky reaches it) .. 1 (open sky)
out vec3 vPosition;
out vec3 vNormal;
flat out int vFace;
flat out int vMaterial;
out vec3 vLocal; // position in the chunk: small texture coordinates, precise far from the origin

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

const float AO[4] = float[4](0.25, 0.5, 0.75, 1.0);

void main() {
    vec3 local = vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u)) * chunkScale;
    int face = int((data >> 21) & 7u);
    int ao = int((data >> 24) & 3u);
    int material = int((data >> 26) & 7u);

    vPosition = chunkOrigin + local;
    vNormal = NORMALS[face];
    vFace = face;
    vMaterial = material;
    vLocal = local;
    vAO = AO[ao];
    vSkyLight = float((data >> 29) & 7u) / 7.0;
    gl_Position = viewProj * vec4(vPosition, 1.0);
}
