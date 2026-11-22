#version 300 es
precision highp float;
precision mediump sampler2DArray;

// Half resolution pass: trees get the face id 7 (8 / 255), so the shadow pass traces their terrain shadow.
in vec3 vLocal;
flat in vec3 vLocalNormal;
flat in int vMaterial;
flat in float vTint;

out vec4 fragFace;

@import ./tree_surface;

void main() {
    treeTexel(vMaterial, treeUV(vLocal, vLocalNormal, vTint * 7.0)); // the gaps of the leaves stay empty
    fragFace = vec4(8.0 / 255.0, 0.0, 0.0, 1.0);
}
