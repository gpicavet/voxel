// Light shafts computed by atmosphere_fragment.glsl at quarter resolution: smooth, one filtered read is enough.

uniform sampler2D atmosphereScatter;
uniform vec2 screenSize;
uniform bool atmosphereOn;

vec3 lightShaftsAt() {
    return atmosphereOn ? texture(atmosphereScatter, gl_FragCoord.xy / screenSize).rgb : vec3(0.0);
}
