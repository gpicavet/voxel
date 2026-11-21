#version 300 es
precision highp float;
precision highp sampler2D;

// Water faces (mesher.js buildWaterMesh): same packed vertex as the terrain.
layout(location=0) in uint data;

uniform mat4 viewProj;
uniform vec3 chunkOrigin;
uniform float seaLevel;

out vec3 vPosition;
flat out int vFace;
// lighting terms that are the same for the whole water: computed per vertex instead of per pixel
flat out vec3 vSkyUp;
flat out vec3 vAmbientUp;

@import ./common;

void main() {
    vec3 p = chunkOrigin + vec3(float(data & 127u), float((data >> 7) & 127u), float((data >> 14) & 127u));
    vFace = int((data >> 21) & 7u);
    // the surface sits a little below the top of the voxels, like the water of a block game
    if(p.z > seaLevel - 0.5) p.z = seaLevel - 0.12;
    vPosition = p;
    vSkyUp = skyRadiance(vec3(0.0, 0.0, 1.0));
    vAmbientUp = ambientLight(vec3(0.0, 0.0, 1.0));
    gl_Position = viewProj * vec4(p, 1.0);
}
