// Shadow rays through the voxels of the window loaded around the camera (needs precision lowp usampler3D).
// The window wraps around the textures in x and y: a column always lives in the same slot while it is loaded.

uniform usampler3D brickTex;  // 1 texel = 2x2x2 voxels, 1 bit each: bit (x & 1) | (y & 1) << 1 | (z & 1) << 2
uniform usampler3D coarseTex; // 1 texel = 8x8x8 voxels, 0 when they are all empty
uniform vec3 windowMin;       // world position of the window corner (z = bottom of the world)
uniform vec3 windowSize;      // in voxels
uniform ivec3 brickOrigin;    // texel of the window corner in each texture
uniform ivec3 coarseOrigin;
// horizon: surface heights of the generated terrain every horizonStep voxels, far around the camera (world.js)
precision highp isampler2D;
uniform isampler2D horizonTex;
uniform vec2 horizonOrigin;   // world xy of the first sample
uniform float horizonStep;
uniform bool horizonValid;

const int COARSE_POW = 3; // must match constants.js
const int MAX_STEPS = 256;
const float MAX_TERRAIN = 121.0; // highest generated surface + 1 (MAX_HEIGHT of constants.js)
const int HORIZON_STEPS = 320;   // 8 voxels each: 2560 voxels

// The ray left the loaded window sideways, at world position p, below the highest terrain: go on against the height map
// of the generated terrain (bilinear, ignores caves and overhangs), until it rises above all the terrain or leaves the map.
float horizonVisibility(vec3 p, vec3 rd) {
    float horizontal = length(rd.xy);
    if(!horizonValid || horizontal < 1e-4) return 1.0;
    float dt = 8.0 / horizontal;
    vec2 last = vec2(textureSize(horizonTex, 0) - 2);
    for(int i = 1; i <= HORIZON_STEPS; i++) {
        vec3 q = p + rd * (float(i) * dt);
        if(q.z >= MAX_TERRAIN) return 1.0;
        vec2 g = (q.xy - horizonOrigin) / horizonStep;
        if(any(lessThan(g, vec2(0.0))) || any(greaterThan(g, last))) return 1.0;
        ivec2 c = ivec2(g);
        vec2 f = g - vec2(c);
        float h = mix(mix(float(texelFetch(horizonTex, c, 0).r), float(texelFetch(horizonTex, c + ivec2(1, 0), 0).r), f.x),
            mix(float(texelFetch(horizonTex, c + ivec2(0, 1), 0).r), float(texelFetch(horizonTex, c + ivec2(1, 1), 0).r), f.x), f.y);
        if(q.z < h) return 0.0;
    }
    return 1.0;
}

// Voxel traversal towards the light: every voxel crossed by the ray is tested (no fixed step that could
// miss a corner), empty 8^3 then 2^3 blocks are crossed in one step. A ray that leaves the loaded window sideways, or
// runs too long along the slopes (low sun), goes on against the coarse height map of the terrain: the distant mountains
// cast their shadows at sunset, and neighbouring rays never alternate between lit and dark (bright streaks).
// Returns 1 when lit, 0 in the shadow.
float castShadowRay(vec3 startPos, vec3 rd) {
    // light at or below the horizon: blocked by the terrain all around (the rays would run flat across the world)
    if(rd.z <= 0.0) return 0.0;
    rd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
    vec3 invRd = 1.0 / rd;
    vec3 towards = step(0.0, rd); // 1 on the axes where the ray goes up
    vec3 ro = startPos - windowMin; // window coordinates: small numbers, so precise even far from the origin
    ivec3 brickMask = textureSize(brickTex, 0) - 1;
    ivec3 coarseMask = textureSize(coarseTex, 0) - 1;
    float t = 0.0;

    for(int i = 0; i < MAX_STEPS; i++) {
        vec3 pos = ro + rd * t;
        if(pos.z < 0.0) {
            return 0.0; // below the world: rock
        }
        if(pos.z >= windowSize.z) {
            return 1.0; // above the world: lit
        }
        if(any(lessThan(pos.xy, vec2(0.0))) || any(greaterThanEqual(pos.xy, windowSize.xy))) {
            // out of the loaded window: the terrain further away decides
            return horizonVisibility(pos + windowMin, rd);
        }
        ivec3 cell = ivec3(pos);

        // size (power of 2) of the empty box the ray is in
        int boxPow;
        if(texelFetch(coarseTex, ((cell >> COARSE_POW) + coarseOrigin) & coarseMask, 0).r == 0u) {
            boxPow = COARSE_POW;
        } else {
            uint brick = texelFetch(brickTex, ((cell >> 1) + brickOrigin) & brickMask, 0).r;
            if(brick == 0u) {
                boxPow = 1;
            } else if(((brick >> uint((cell.x & 1) | ((cell.y & 1) << 1) | ((cell.z & 1) << 2))) & 1u) != 0u) {
                return 0.0; // Ombre
            } else {
                boxPow = 0;
            }
        }

        // jump just past the exit of that box
        vec3 boxMin = vec3((cell >> boxPow) << boxPow);
        vec3 tExit = (boxMin + towards * float(1 << boxPow) - ro) * invRd;
        t = min(min(tExit.x, tExit.y), tExit.z) + 1e-3;
    }

    // still close to the terrain after MAX_STEPS: a grazing ray (low sun) running along the slopes; the coarse height
    // map decides from there, like for the rays that leave the window
    return horizonVisibility(ro + rd * t + windowMin, rd);
}

// Cheaper visibility of the light from a point in the air, for the light shafts: only the 8^3 coarse occupancy
// (an occupied block counts as solid), and a bounded number of steps. 1 = lit.
float coarseVisibility(vec3 startPos, vec3 rd, int maxSteps) {
    rd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
    vec3 invRd = 1.0 / rd;
    vec3 towards = step(0.0, rd);
    vec3 ro = startPos - windowMin;
    ivec3 coarseMask = textureSize(coarseTex, 0) - 1;
    float t = 0.0;
    for(int i = 0; i < maxSteps; i++) {
        vec3 pos = ro + rd * t;
        if(pos.z < 0.0) return 0.0;
        if(any(lessThan(pos.xy, vec2(0.0))) || any(greaterThanEqual(pos, windowSize))) return 1.0;
        ivec3 block = ivec3(pos) >> COARSE_POW;
        if(texelFetch(coarseTex, (block + coarseOrigin) & coarseMask, 0).r != 0u) return 0.0;
        vec3 tExit = (vec3(block << COARSE_POW) + towards * float(1 << COARSE_POW) - ro) * invRd;
        t = min(min(tExit.x, tExit.y), tExit.z) + 1e-3;
    }
    return 1.0;
}
