#version 300 es
precision highp float;

// One direction of a 9 tap gaussian blur (the red channel), taps step apart (texture coordinates).
uniform sampler2D source;
uniform vec2 step;

out vec4 fragColor;

const float WEIGHTS[5] = float[5](0.2270, 0.1945, 0.1216, 0.0540, 0.0162);

void main() {
    vec2 uv = gl_FragCoord.xy / vec2(textureSize(source, 0));
    float sum = texture(source, uv).r * WEIGHTS[0];
    for(int i = 1; i < 5; i++) {
        sum += (texture(source, uv + step * float(i)).r + texture(source, uv - step * float(i)).r) * WEIGHTS[i];
    }
    fragColor = vec4(sum, 0.0, 0.0, 1.0);
}
