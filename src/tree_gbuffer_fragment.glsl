#version 300 es
precision mediump float;

// Half resolution pass: trees get the face id 7 (8 / 255), so the shadow pass traces their terrain shadow.
out vec4 fragFace;

void main() {
    fragFace = vec4(8.0 / 255.0, 0.0, 0.0, 1.0);
}
