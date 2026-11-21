#version 300 es
precision highp float;

uniform mat4 invViewProj;
uniform vec3 camPosition;
uniform vec3 lightDir;

in vec2 vNdc;

out vec4 fragColor;

@import ./common;

void main() {
    vec4 far = invViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w - camPosition);
    vec3 sunDir = -lightDir;

    vec3 sky = skyColor(dir, sunDir);
    sky += SUN_COLOR * 4.0 * smoothstep(0.9994, 0.9997, dot(dir, sunDir)); // sun disk

    fragColor = vec4(toneMap(sky), 1.0);
}
