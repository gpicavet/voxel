#version 300 es
precision mediump float;

// Half resolution pass: the depth buffer and the face direction of the nearest surface, read by the shadow pass.
flat in int vFace;

out vec4 fragFace;

void main() {
    fragFace = vec4(float(vFace + 1) / 255.0, 0.0, 0.0, 1.0); // 0 = sky
}
