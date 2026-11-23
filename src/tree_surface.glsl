// Textures of the trees (needs precision for sampler2DArray):
// - bark and wood: high resolution textures of textures.js, mapped in meters on the faces
// - foliage: Minecraft-like pixel art (leafTextures.js), one texture per face of a leaf voxel, with transparent holes
//   cut out at the finest level of detail (further, the foliage is full and the holes are dark green)

uniform sampler2DArray voxelAlbedo;
uniform sampler2DArray voxelNormals;
uniform sampler2DArray leafTextures;
uniform sampler2DArray leafMotion; // per texel: phase, amplitude and speed of its clump of leaves (leafTextures.js)
uniform float windTime;            // seconds
uniform float voxelSize;
uniform bool cutout;

const float TREE_TILE = 1.0; // meters covered by one bark texture

// bark layer of each wood material (textures.js); leaf layer of each foliage material (leafTextures.js)
const int BARK_LAYERS[7] = int[7](6, 0, 7, 0, 8, 0, 6);
const int LEAF_LAYERS[7] = int[7](0, 0, 0, 2, 0, 1, 3);

bool isLeaf(int material) {
    return material == 1 || material == 3 || material == 5 || material == 6;
}

float voxelHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

// coordinates on the face plane, in model voxels; the sides run with the height
vec2 facePlane(vec3 local, vec3 localNormal) {
    vec3 n = abs(localNormal);
    return n.x > 0.5 ? local.yz : n.y > 0.5 ? local.xz : local.xy;
}

// bark texture coordinates, in meters
vec2 treeUV(vec3 local, vec3 localNormal, float offset) {
    return facePlane(local, localNormal) * voxelSize / TREE_TILE + offset;
}

// foliage texel: one texture per voxel face, mirrored on the sides and turned on the top and bottom faces depending on the
// voxel (less repetition); gradients from the continuous coordinates, so the mipmaps have no seams at the voxel edges
const vec2 WIND_DIRECTION = vec2(0.92, 0.38); // the wind of the clouds
const float LEAF_SWAY = 1.6;   // texels: how far a clump of leaves moves
const float LEAF_TURN = 0.3;   // brightness change of a turning leaf

// Leaves in the wind: each clump of leaves of the texture moves back and forth in the plane of the face, with its own
// phase, amplitude and speed, and turns (lighter facing the light, paler when it shows its underside). Gusts travel
// across the forest. Only up close: when the texels get smaller than the pixels, the motion fades out (it would shimmer).
vec4 leafTexel(int material, vec3 local, vec3 localNormal, vec3 worldPos) {
    vec2 p = facePlane(local, localNormal);
    vec2 dx = dFdx(p), dy = dFdy(p);
    vec3 voxel = floor(local - localNormal * 0.5);
    vec2 f = fract(p) - 0.5;
    float h = voxelHash(voxel);
    if(abs(localNormal.z) > 0.5) {
        // top and bottom: one of 4 rotations
        int turns = int(h * 4.0);
        for(int i = 0; i < 3; i++) {
            if(i >= turns) break;
            f = vec2(-f.y, f.x);
            dx = vec2(-dx.y, dx.x);
            dy = vec2(-dy.y, dy.x);
        }
    } else if(h > 0.5) {
        // sides: mirrored, the leaves keep hanging down
        f.x = -f.x;
        dx.x = -dx.x;
        dy.x = -dy.x;
    }
    float layer = float(LEAF_LAYERS[material]);
    vec2 texels = vec2(textureSize(leafTextures, 0).xy);
    float lod = max(0.5 * log2(max(dot(dx * texels, dx * texels), dot(dy * texels, dy * texels))), 0.0);
    float wind = clamp(1.0 - lod, 0.0, 1.0);
    vec2 uv = f + 0.5;
    float turn = 0.0;
    if(wind > 0.0) {
        float gust = 0.7 + 0.3 * sin(windTime * 0.8 - dot(worldPos.xy, WIND_DIRECTION) * 0.07);
        wind *= gust;
        // the clump shown at this texel moves: look up the texture back along its motion
        vec4 m = texelFetch(leafMotion, ivec3(ivec2(floor(uv * texels)) & 15, int(layer)), 0);
        float phase = m.r * 6.2831853, speed = 0.75 + 0.5 * m.b;
        vec2 sway = vec2(sin(windTime * 3.0 * speed + phase), sin(windTime * 2.2 * speed + phase * 1.7));
        uv -= sway * LEAF_SWAY * m.g * wind / texels;
        // the clump that ends up shown turns on itself
        vec4 shown = texelFetch(leafMotion, ivec3(ivec2(floor(uv * texels)) & 15, int(layer)), 0);
        turn = sin(windTime * 1.9 * (0.75 + 0.5 * shown.b) + shown.r * 14.5) * shown.g * wind;
    }
    vec4 texel = textureGrad(leafTextures, vec3(uv, layer), dx, dy);
    texel.rgb *= 1.0 + LEAF_TURN * turn;
    if(turn < 0.0) texel.rgb = mix(texel.rgb, texel.rgb * vec3(1.12, 1.2, 0.8), -turn * 0.4); // paler underside
    if(cutout) {
        // the mipmaps average the alpha: raise it with the mip level, so the foliage keeps its coverage far away
        if(texel.a * (1.0 + lod * 0.3) < 0.5) discard;
    }
    return texel;
}

// texel of any tree material (discards the holes of the foliage when cutout)
vec4 treeTexel(int material, vec3 local, vec3 localNormal, float offset, vec3 worldPos) {
    if(isLeaf(material)) return leafTexel(material, local, localNormal, worldPos);
    return texture(voxelAlbedo, vec3(treeUV(local, localNormal, offset), float(BARK_LAYERS[material])));
}
