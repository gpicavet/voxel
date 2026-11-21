// Shadow rays through the voxel occupancy textures (needs precision lowp usampler3D).

uniform usampler3D terrainTex; // 1 texel = 1 voxel
uniform usampler3D midTex;     // 1 texel = 2^3 voxels, 0 when they are all empty
uniform usampler3D coarseTex;  // 1 texel = 8^3 voxels, 0 when they are all empty
uniform vec3 terrainOffset;    // world coordinates + offset = texture coordinates
uniform vec3 terrainDim;

const int MID_POW = 1;    // must match terrain.js
const int COARSE_POW = 3; // must match terrain.js
const int MAX_STEPS = 256;

// Voxel traversal towards the light: every voxel crossed by the ray is tested (no fixed step that could
// miss a corner), empty 8^3 then 2^3 blocks are crossed in one step, and the ray stops as soon as it
// leaves the terrain. Returns 1 when lit, 0 in the shadow.
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

        // size (power of 2) of the empty box the ray is in
        int boxPow;
        if(texelFetch(coarseTex, cell >> COARSE_POW, 0).r == 0u) {
            boxPow = COARSE_POW;
        } else if(texelFetch(midTex, cell >> MID_POW, 0).r == 0u) {
            boxPow = MID_POW;
        } else if(texelFetch(terrainTex, cell, 0).r > 0u) {
            return 0.0; // Ombre
        } else {
            boxPow = 0;
        }

        // jump just past the exit of that box
        vec3 boxMin = vec3((cell >> boxPow) << boxPow);
        vec3 tExit = (boxMin + towards * float(1 << boxPow) - ro) * invRd;
        t = min(min(tExit.x, tExit.y), tExit.z) + 1e-3;
    }

    return 1.0;
}
