// Voxel clouds: a few layers of big blocks above the mountains, drifting with the wind (needs precision highp sampler3D).
// A cell is filled or not, from the tiling noise texture of cloudNoise.js; rays cross the cells with a grid traversal.

uniform sampler3D cloudNoise;  // r Perlin-Worley (puffs), g Worley fbm (weather)
uniform float cloudTime;       // seconds, for the wind
uniform float cloudCoverage;   // 0 clear .. 1 overcast

const vec3 CLOUD_CELL = vec3(8.0, 8.0, 6.0);
const int CLOUD_LAYERS = 4;
const float CLOUD_BOTTOM = 210.0;
const float CLOUD_TOP = CLOUD_BOTTOM + 24.0; // CLOUD_CELL.z * CLOUD_LAYERS
const vec2 WIND = vec2(6.0, 2.5);            // meters per second
const float CLOUD_FADE = 2500.0;             // far clouds melt into the sky (and do not flicker, smaller than a pixel)
const int CLOUD_STEPS = 96;

float remap(float v, float lo, float hi, float newLo, float newHi) {
    return newLo + (v - lo) * (newHi - newLo) / (hi - lo);
}

// is the cell filled? (cell coordinates in the frame moving with the wind, layer in z)
bool cloudCell(ivec3 c) {
    if(c.z < 0 || c.z >= CLOUD_LAYERS || cloudCoverage <= 0.0) return false;
    vec3 cell = vec3(c) + 0.5;
    // the local coverage varies around the global one, over large areas
    float weather = textureLod(cloudNoise, vec3(cell.xy / 900.0, 0.37), 0.0).g; // mean 0.48, +-0.2
    float coverage = clamp(cloudCoverage + (weather - 0.48) * 1.5, 0.0, 1.0);
    // puffs, two scales so that the 64 cell period of the texture does not show
    float puff = textureLod(cloudNoise, vec3(cell.xy / 64.0, cell.z / 10.0), 0.0).r * 0.7
        + textureLod(cloudNoise, vec3(cell.xy / 23.0 + 0.31, cell.z / 7.0 + 0.5), 0.0).r * 0.3;
    // fuller in the lower middle layers: flat bottoms, bumpy tops
    float profile = 1.0 - abs(cell.z / float(CLOUD_LAYERS) - 0.4) * 0.9;
    return clamp(remap(puff, 0.35, 0.8, 0.0, 1.0), 0.0, 1.0) * profile > 1.0 - coverage;
}

// world position -> cell space (cells of size 1, layer 0 at the bottom of the clouds, moving with the wind)
vec3 toCloudSpace(vec3 p) {
    return (p - vec3(WIND * cloudTime, CLOUD_BOTTOM)) / CLOUD_CELL;
}

// distances where a ray crosses the cloud layer; false if it does not
bool cloudLayer(vec3 ro, vec3 rd, out float t0, out float t1) {
    if(abs(rd.z) < 1e-4) {
        t0 = 0.0;
        t1 = 1e5;
        return ro.z > CLOUD_BOTTOM && ro.z < CLOUD_TOP;
    }
    float tb = (CLOUD_BOTTOM - ro.z) / rd.z, tt = (CLOUD_TOP - ro.z) / rd.z;
    t0 = max(min(tb, tt), 0.0);
    t1 = max(tb, tt);
    return t1 > 0.0;
}

// First filled cell along the ray before tMax: distance (or -1), normal of the face hit, cell.
float traceClouds(vec3 ro, vec3 rd, float tMax, out vec3 normal, out ivec3 cell) {
    float t0, t1;
    normal = vec3(0.0, 0.0, 1.0);
    cell = ivec3(0);
    if(!cloudLayer(ro, rd, t0, t1)) return -1.0;
    t1 = min(t1, tMax);
    if(t0 >= t1) return -1.0;

    vec3 rdc = rd / CLOUD_CELL;
    rdc = mix(rdc, vec3(1e-7), lessThan(abs(rdc), vec3(1e-7)));
    vec3 start = toCloudSpace(ro + rd * t0);
    cell = ivec3(floor(start));
    cell.z = clamp(cell.z, 0, CLOUD_LAYERS - 1); // entering exactly through the bottom or the top plane
    ivec3 stp = ivec3(sign(rdc));
    vec3 tDelta = abs(1.0 / rdc);
    vec3 tNext = t0 + (vec3(cell) + max(vec3(stp), 0.0) - start) / rdc;
    normal = ro.z < CLOUD_BOTTOM ? vec3(0.0, 0.0, -1.0) : ro.z > CLOUD_TOP ? vec3(0.0, 0.0, 1.0) : -rd;
    float t = t0;
    for(int i = 0; i < CLOUD_STEPS; i++) {
        if(cloudCell(cell)) return t;
        if(tNext.x < tNext.y && tNext.x < tNext.z) {
            t = tNext.x; tNext.x += tDelta.x; cell.x += stp.x; normal = vec3(-float(stp.x), 0.0, 0.0);
        } else if(tNext.y < tNext.z) {
            t = tNext.y; tNext.y += tDelta.y; cell.y += stp.y; normal = vec3(0.0, -float(stp.y), 0.0);
        } else {
            t = tNext.z; tNext.z += tDelta.z; cell.z += stp.z; normal = vec3(0.0, 0.0, -float(stp.z));
        }
        if(t > t1 || cell.z < 0 || cell.z >= CLOUD_LAYERS) return -1.0;
    }
    return -1.0;
}

// light that the clouds let through from p towards the light (blocky cloud shadows on the terrain)
float cloudShadow(vec3 p, vec3 toLight) {
    if(toLight.z <= 0.0 || cloudCoverage <= 0.0 || p.z > CLOUD_TOP) return 1.0;
    for(int k = 0; k < CLOUD_LAYERS; k++) {
        float z = CLOUD_BOTTOM + (float(k) + 0.5) * CLOUD_CELL.z;
        vec3 q = toCloudSpace(p + toLight * ((z - p.z) / toLight.z));
        if(cloudCell(ivec3(floor(q.xy), k))) return 0.15;
    }
    return 1.0;
}
