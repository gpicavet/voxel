#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;

uniform usampler3D terrainTex; // 1 texel = 1 voxel
uniform usampler3D coarseTex;  // 1 texel = 8^3 voxels, 0 when they are all empty
uniform vec3 lightDir; // Direction de la lumière (normalisée)
uniform vec3 terrainOffset; // offset pour la texture
uniform vec3 terrainDim; // dim pour la texture

in vec3 vColor;
in vec3 vPosition;
in vec3 vNormal;

out vec4 fragColor;

const int COARSE_POW = 3;
const float COARSE = 8.0;
const int MAX_STEPS = 256;

// Voxel traversal towards the light. Every voxel crossed by the ray is tested (no fixed step that could
// miss a corner), whole empty 8^3 blocks are crossed in one step, and the ray stops as soon as it
// leaves the terrain.
float castShadowRay(vec3 startPos, vec3 rd) {
    rd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
    vec3 invRd = 1.0 / rd;
    vec3 towards = step(0.0, rd); // 1 on the axes where the ray goes up
    vec3 ro = startPos + terrainOffset;
    float t = 0.0;

    for(int i = 0; i < MAX_STEPS; i++) {
        vec3 pos = ro + rd * t;
        if(any(lessThan(pos, vec3(0.0))) || any(greaterThanEqual(pos, terrainDim))) {
            return 1.0; // left the terrain: lit
        }
        ivec3 cell = ivec3(pos);
        ivec3 block = cell >> COARSE_POW;

        vec3 boxMin;
        float boxSize;
        if(texelFetch(coarseTex, block, 0).r == 0u) {
            boxMin = vec3(block << COARSE_POW);
            boxSize = COARSE;
        } else {
            if(texelFetch(terrainTex, cell, 0).r > 0u) {
                return 0.2; // Ombre
            }
            boxMin = vec3(cell);
            boxSize = 1.0;
        }
        // jump just past the exit of the current voxel or block
        vec3 tExit = (boxMin + towards * boxSize - ro) * invRd;
        t = min(min(tExit.x, tExit.y), tExit.z) + 1e-3;
    }

    return 1.0;
}

void main() {
    float ndotl = max(dot(vNormal, -lightDir), 0.0);

    // faces turned away from the sun are in the shadow anyway: no ray
    float shadow = ndotl > 0.0 ? castShadowRay(vPosition + vNormal * 1e-3, -lightDir) : 0.2;

    vec3 lit = vColor * ndotl;
    vec3 color = lit * 0.2f + lit * 0.8f * shadow;

    //fog
    float a = gl_FragCoord.z / gl_FragCoord.w * 0.001f;
    color = color * (1.0f - a) + vec3(0.7f, 0.9f, 1) * a;

    fragColor = vec4(color, 1);
}
