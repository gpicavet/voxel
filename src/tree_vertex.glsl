#version 300 es
precision highp float;

// Trees: a voxel model (treeModels.js, same packed vertex as the terrain) placed by instance attributes.
layout(location=0) in uint data;
layout(location=1) in vec4 instancePosition; // base (world) and yaw
layout(location=2) in vec4 instanceData;     // scale, tint, sky light (0..1), sway phase
layout(location=3) in uint extra;            // variant of the foliage, fringe and its corner (treeModels.js meshGrid)

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
flat out int vVariant;
out vec3 vFringe; // fringe of the foliage: 1, then the position on the voxel face (0..1 on it); 0 for the voxel faces
flat out float vTint;
flat out float vSkyLight;
flat out float vYaw;
out float vOpenness; // sky seen through the tree itself (baked in the model)
out float vHeight;   // meters above the foot of the tree

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));
const float AO[4] = float[4](0.35, 0.6, 0.8, 1.0);
const vec2 WIND_DIRECTION = vec2(0.92, 0.38); // the wind of the clouds

// fringe of the foliage (drawn for the nearest trees, trees.js): pushed out of the face and grown towards the edges of
// the foliage (model voxels)
const float FRINGE_OUT = 0.3;
const float FRINGE_GROW = 0.45;

void main() {
    vec3 local = vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    int face = int((data >> 21) & 7u);
    vFringe = vec3(0.0);
    if((extra & 4u) != 0u) {
        int axis = face >> 1, u = axis == 0 ? 1 : 0, v = axis == 2 ? 1 : 2;
        vec2 corner = vec2(float((extra >> 3) & 1u), float((extra >> 4) & 1u));
        vec2 grow = vec2(float((extra >> 5) & 1u), float((extra >> 6) & 1u)) * (corner * 2.0 - 1.0) * FRINGE_GROW;
        local += NORMALS[face] * FRINGE_OUT;
        local[u] += grow.x;
        local[v] += grow.y;
        vFringe = vec3(1.0, corner + grow);
    }
    int material = int((data >> 26) & 7u);
    float scale = instanceData.x;

    vec3 p = (local - modelOrigin) * voxelSize * scale;
    float c = cos(instancePosition.w), s = sin(instancePosition.w);
    vec3 rest = instancePosition.xyz + vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
    vRestPosition = rest;
    // Slight motion of the whole tree (the leaves also flutter inside their texture, tree_surface.glsl). The offset only
    // depends on the rest position of the vertex: the corners shared by neighbouring blocks move together, nothing slides,
    // and wood and leaves move alike, so the foliage stays on its branches.
    vec3 offset = vec3(0.0);
    if(windTime > 0.0) {
        float gust = 0.7 + 0.3 * sin(windTime * 0.8 - dot(rest.xy, WIND_DIRECTION) * 0.07);
        float phase = instanceData.w;
        // the tree bends with the wind, more and more towards the top, rooted in the ground
        float h = max(p.z, 0.0) / 10.0;
        offset.xy = WIND_DIRECTION * (0.1 * h * h * (0.6 + 0.4 * sin(windTime * 0.7 + phase)) * gust);
        // limbs and pads move in small loops, along waves wide enough for neighbouring blocks to move together
        float reach = smoothstep(0.5, 6.0, length(p.xy)) * smoothstep(1.5, 5.0, p.z);
        float a = windTime * 1.5 + phase + dot(rest, vec3(0.9, 0.7, 0.5));
        offset += reach * 0.06 * gust * vec3(sin(a), cos(a * 1.3), 0.4 * sin(a * 0.7));
    }
    vPosition = rest + offset;
    vec3 n = NORMALS[face];
    vNormal = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
    vLocal = local;
    vLocalNormal = n;
    vAO = AO[(data >> 24) & 3u];
    vMaterial = material;
    vVariant = int(extra & 3u);
    vTint = instanceData.y;
    vSkyLight = instanceData.z;
    vYaw = instancePosition.w;
    vOpenness = float(data >> 29u) / 7.0;
    vHeight = p.z;
    gl_Position = viewProj * vec4(vPosition, 1.0);
}
