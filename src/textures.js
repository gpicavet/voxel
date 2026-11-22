// Realistic voxel textures, generated on the GPU at startup (texture_gen_fragment.glsl, no image file):
// albedo and normal map, 512 x 512, one layer per material (0 earth, 1 rock, 2 grass, 3 snow, 4 sand), and the normal map
// of the small waves of the water (5).
// They tile without seams; the terrain shader maps one texture on 4 x 4 voxels.

export const TEXTURE_SIZE = 512;
const LAYERS = 6;

function createArray(gl, unit, internalFormat) {
    gl.activeTexture(unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    const levels = Math.log2(TEXTURE_SIZE) + 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internalFormat, TEXTURE_SIZE, TEXTURE_SIZE, LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // terrain is often seen at grazing angles
    const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
    if (anisotropic) {
        const max = gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
    return texture;
}

/**
 * @param program the generation program ({program, locations} with "layer" and "size"), drawn as a fullscreen triangle
 */
export function createVoxelTextures(gl, program, albedoUnit, normalUnit) {
    const albedo = createArray(gl, albedoUnit, gl.SRGB8_ALPHA8); // the shaders read linear colors
    const normal = createArray(gl, normalUnit, gl.RGBA8);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(program.program);
    gl.uniform1f(program.locations.size, TEXTURE_SIZE);
    for (let layer = 0; layer < LAYERS; layer++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, albedo, 0, layer);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, normal, 0, layer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Texture framebuffer incomplete : 0x" + status.toString(16));
        gl.uniform1i(program.locations.layer, layer);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.enable(gl.DEPTH_TEST);

    for (const [unit, texture] of [[albedoUnit, albedo], [normalUnit, normal]]) {
        gl.activeTexture(unit);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
    gl.activeTexture(gl.TEXTURE0);
}
