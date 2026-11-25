// Textures of the trees (needs precision for sampler2DArray):
// - bark and wood: high resolution textures of textures.js, mapped in meters on the faces, their furrows along the
//   branches
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
const float LEAF_TILE = 1.0; // meters covered by one foliage texture (leafTextures.js)
const float FRINGE_GROW = 0.45; // how far the fringe grows beyond the voxel face (tree_vertex.glsl)

// bark layer of each wood material (textures.js), the spruces have their own (variant SPRUCE_BARK of the bark); first
// leaf layer of each foliage material and its number of variants (leafTextures.js, treeModels.js): 1 oak, 3 needles,
// 5 birch, 6 bush, 7 blossom
const int BARK_LAYERS[8] = int[8](6, 0, 7, 0, 8, 0, 6, 0);
const int SPRUCE_BARK = 1, SPRUCE_BARK_LAYER = 9;
const int LEAF_BASE[8] = int[8](0, 0, 0, 3, 0, 5, 7, 9);
const int LEAF_VARIANTS[8] = int[8](1, 3, 1, 2, 1, 2, 2, 3);

bool isLeaf(int material) {
    return material == 1 || material == 3 || material == 5 || material == 6 || material == 7;
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

int barkLayer(int material, int variant) {
    return material == 0 && variant == SPRUCE_BARK ? SPRUCE_BARK_LAYER : BARK_LAYERS[material];
}

// bark texture coordinates, in meters, turned so that v (the long furrows of the textures) runs along grain: the
// direction of the branch on the face plane (tree_vertex.glsl). The tangents of the texture: treeTangents.
vec2 treeUV(vec3 local, vec3 localNormal, vec2 grain, float offset) {
    vec2 p = facePlane(local, localNormal) * voxelSize / TREE_TILE;
    return vec2(p.x * grain.y - p.y * grain.x, dot(p, grain)) + offset;
}

// model space directions of the u and v of the texture on a face (treeUV)
void treeTangents(vec3 localNormal, vec2 grain, out vec3 tu, out vec3 tv) {
    vec3 n = abs(localNormal);
    vec3 a = n.x > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0); // the axes of facePlane
    vec3 b = n.z > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
    tu = a * grain.y - b * grain.x;
    tv = a * grain.x + b * grain.y;
}

// foliage texel: one texture per LEAF_TILE of the faces (the same size at every level of detail), mirrored on the sides
// and turned on the top and bottom faces depending on the tile (less repetition); gradients from the continuous
// coordinates, so the mipmaps have no seams at the tile edges
const vec2 WIND_DIRECTION = vec2(0.92, 0.38); // the wind of the clouds
const float LEAF_SWAY = 0.7;   // texels: how far a leaf moves (more would tear the leaves apart)
const float LEAF_TURN = 0.3;   // brightness change of a turning leaf

// Leaves in the wind: each clump of leaves of the texture moves back and forth in the plane of the face, with its own
// phase, amplitude and speed, and turns (lighter facing the light, paler when it shows its underside). Gusts travel
// across the forest. Only up close: when the texels get smaller than the pixels, the motion fades out (it would shimmer).
vec4 leafTexel(int material, int variant, vec3 local, vec3 localNormal, vec3 worldPos, vec3 fringe) {
    float scale = voxelSize / LEAF_TILE;
    vec2 p = facePlane(local, localNormal) * scale;
    vec2 dx = dFdx(p), dy = dFdy(p);
    vec3 tile = floor((local - localNormal * 0.5) * scale);
    vec2 f = fract(p) - 0.5;
    float h = voxelHash(tile);
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
    float layer = float(LEAF_BASE[material] + min(variant, LEAF_VARIANTS[material] - 1));
    vec2 texels = vec2(textureSize(leafTextures, 0).xy);
    int wrap = int(texels.x) - 1;
    float lod = max(0.5 * log2(max(dot(dx * texels, dx * texels), dot(dy * texels, dy * texels))), 0.0);
    float wind = clamp(1.0 - lod, 0.0, 1.0);
    vec2 uv = f + 0.5;
    float turn = 0.0;
    if(wind > 0.0) {
        float gust = 0.7 + 0.3 * sin(windTime * 0.8 - dot(worldPos.xy, WIND_DIRECTION) * 0.07);
        wind *= gust;
        // the clump shown at this texel moves: look up the texture back along its motion
        vec4 m = texelFetch(leafMotion, ivec3(ivec2(floor(uv * texels)) & wrap, int(layer)), 0);
        float phase = m.r * 6.2831853, speed = 0.75 + 0.5 * m.b;
        vec2 sway = vec2(sin(windTime * 3.0 * speed + phase), sin(windTime * 2.2 * speed + phase * 1.7));
        uv -= sway * LEAF_SWAY * m.g * wind / texels;
        // the clump that ends up shown turns on itself
        vec4 shown = texelFetch(leafMotion, ivec3(ivec2(floor(uv * texels)) & wrap, int(layer)), 0);
        turn = sin(windTime * 1.9 * (0.75 + 0.5 * shown.b) + shown.r * 14.5) * shown.g * wind;
    }
    vec4 texel = textureGrad(leafTextures, vec3(uv, layer), dx, dy);
    if(fringe.x > 0.5) {
        // fringe: whole leaves kept at random, fewer and fewer towards its border (none there); over the voxel face, a few
        // of them, a little in front of it
        vec2 out2 = max(-fringe.yz, fringe.yz - 1.0);
        float outside = max(out2.x, out2.y) / FRINGE_GROW;
        float keep = outside <= 0.0 ? 0.2 : 0.8 * (1.0 - outside);
        // none when the quad is seen edge on (thin streaks of stretched leaves): how much the screen squeezes it
        vec2 ex = dFdx(fringe.yz), ey = dFdy(fringe.yz);
        float squeeze = max(dot(ex, ex), dot(ey, ey)) / max(abs(ex.x * ey.y - ex.y * ey.x), 1e-12);
        keep *= 1.0 - smoothstep(2.5, 5.0, squeeze);
        float leaf = texelFetch(leafMotion, ivec3(ivec2(floor(uv * texels)) & wrap, int(layer)), 0).r;
        if(texel.a < 0.5 || leaf > keep) discard;
    }
    texel.rgb *= 1.0 + LEAF_TURN * turn;
    if(turn < 0.0) texel.rgb = mix(texel.rgb, texel.rgb * vec3(1.12, 1.2, 0.8), -turn * 0.4); // paler underside
    if(cutout) {
        // the mipmaps average the alpha: raise it with the mip level, so the foliage keeps its coverage far away
        if(texel.a * (1.0 + lod * 0.3) < 0.5) discard;
    }
    return texel;
}

// texel of any tree material (discards the holes of the foliage when cutout)
vec4 treeTexel(int material, int variant, vec2 grain, vec3 local, vec3 localNormal, float offset, vec3 worldPos, vec3 fringe) {
    if(isLeaf(material)) return leafTexel(material, variant, local, localNormal, worldPos, fringe);
    return texture(voxelAlbedo, vec3(treeUV(local, localNormal, grain, offset), float(barkLayer(material, variant))));
}
