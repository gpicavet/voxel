// Textures of the trees (needs precision for sampler2DArray): bark, leaves and needles of textures.js, mapped in meters
// on the faces of the voxels. Leaves and needles of the finest level of detail have transparent gaps (cutout).

uniform sampler2DArray voxelAlbedo;
uniform sampler2DArray voxelNormals;
uniform float voxelSize;
uniform bool cutout;

const float TREE_TILE = 1.0; // meters covered by one texture

// texture layer of each tree material (textures.js): bark, oak leaves, birch bark, needles, dead wood, birch leaves, bush
const int TREE_LAYERS[7] = int[7](6, 9, 7, 10, 8, 9, 9);

bool isLeaf(int material) {
    return material == 1 || material == 3 || material == 5 || material == 6;
}

// texture coordinates of the fragment on its face; the sides run with the height
vec2 treeUV(vec3 local, vec3 localNormal, float offset) {
    vec3 m = local * voxelSize;
    vec3 n = abs(localNormal);
    vec2 uv = n.x > 0.5 ? m.yz : n.y > 0.5 ? m.xz : m.xy;
    return uv / TREE_TILE + offset;
}

// texel of the tree material; discards the transparent gaps of the leaves when cutout
vec4 treeTexel(int material, vec2 uv) {
    vec4 texel = texture(voxelAlbedo, vec3(uv, float(TREE_LAYERS[material])));
    if(cutout && isLeaf(material)) {
        // the mipmaps average the alpha: raise it with the mip level, so the foliage keeps its coverage far away
        vec2 texels = uv * vec2(textureSize(voxelAlbedo, 0).xy);
        float lod = max(0.5 * log2(max(dot(dFdx(texels), dFdx(texels)), dot(dFdy(texels), dFdy(texels)))), 0.0);
        if(texel.a * (1.0 + lod * 0.3) < 0.5) discard;
    }
    return texel;
}
