#version 300 es
precision highp float;

// Camera under the water: a turquoise veil over the image, lit like the water body.
uniform float veil;

out vec4 fragColor;

@import ./common;

void main() {
    fragColor = vec4(toneMap(underwaterColor()) * veil, veil);
}
