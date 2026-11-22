#version 300 es
precision highp float;

// Trees: a voxel model (treeModels.js, same packed vertex as the terrain) placed by instance attributes.
layout(location=0) in uint data;
layout(location=1) in vec4 instancePosition; // base (world) and yaw
layout(location=2) in vec4 instanceData;     // scale, tint, sky light (0..1), sway phase

uniform mat4 viewProj;
uniform vec3 modelOrigin; // model voxels: center of the base
uniform float voxelSize;
uniform float windTime;   // seconds; 0 = no wind (shadow map)

out vec3 vPosition;
out vec3 vRestPosition; // without the wind: the shadow map of the trees has no wind
out vec3 vNormal;
out vec3 vLocal;             // model voxels, for the texture of the voxel
flat out vec3 vLocalNormal;
out float vAO;
flat out int vMaterial;
flat out float vTint;
flat out float vSkyLight;
flat out float vYaw;

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));
const float AO[4] = float[4](0.35, 0.6, 0.8, 1.0);

void main() {
    vec3 local = vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    int face = int((data >> 21) & 7u);
    int material = int((data >> 26) & 7u);
    float scale = instanceData.x;

    vec3 p = (local - modelOrigin) * voxelSize * scale;
    float c = cos(instancePosition.w), s = sin(instancePosition.w);
    vRestPosition = instancePosition.xyz + vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
    // leaves sway in the wind, more towards the top
    bool leaf = material == 1 || material == 3 || material == 5 || material == 6;
    if(leaf && windTime > 0.0) {
        float phase = instanceData.w + p.z * 0.35;
        p.xy += vec2(sin(windTime * 1.7 + phase), cos(windTime * 1.3 + phase * 1.3)) * 0.012 * p.z;
    }
    vPosition = instancePosition.xyz + vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
    vec3 n = NORMALS[face];
    vNormal = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
    vLocal = local;
    vLocalNormal = n;
    vAO = AO[(data >> 24) & 3u];
    vMaterial = material;
    vTint = instanceData.y;
    vSkyLight = instanceData.z;
    vYaw = instancePosition.w;
    gl_Position = viewProj * vec4(vPosition, 1.0);
}
