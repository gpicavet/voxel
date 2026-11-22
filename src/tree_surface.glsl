// Textures of the trees (needs precision for sampler2DArray):
// - bark and wood: high resolution textures of textures.js, mapped in meters on the faces
// - foliage: Minecraft-like pixel art (leafTextures.js), one texture per face of a leaf voxel, with transparent holes
//   cut out at the finest level of detail (further, the foliage is full and the holes are dark green)

uniform sampler2DArray voxelAlbedo;
uniform sampler2DArray voxelNormals;
uniform sampler2DArray leafTextures;
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
vec4 leafTexel(int material, vec3 local, vec3 localNormal) {
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
    vec4 texel = textureGrad(leafTextures, vec3(f + 0.5, float(LEAF_LAYERS[material])), dx, dy);
    if(cutout) {
        // the mipmaps average the alpha: raise it with the mip level, so the foliage keeps its coverage far away
        vec2 texels = vec2(textureSize(leafTextures, 0).xy);
        float lod = max(0.5 * log2(max(dot(dx * texels, dx * texels), dot(dy * texels, dy * texels))), 0.0);
        if(texel.a * (1.0 + lod * 0.3) < 0.5) discard;
    }
    return texel;
}

// texel of any tree material (discards the holes of the foliage when cutout)
vec4 treeTexel(int material, vec3 local, vec3 localNormal, float offset) {
    if(isLeaf(material)) return leafTexel(material, local, localNormal);
    return texture(voxelAlbedo, vec3(treeUV(local, localNormal, offset), float(BARK_LAYERS[material])));
}
