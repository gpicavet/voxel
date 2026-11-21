// Light shafts computed by atmosphere_fragment.glsl at quarter resolution: smooth, one filtered read is enough.
// x y z: sunlight scattered by the haze, w: transmittance of the haze.

uniform sampler2D atmosphereScatter;
uniform vec2 screenSize;
uniform bool atmosphereOn;

vec4 lightShaftsAt() {
    return atmosphereOn ? texture(atmosphereScatter, gl_FragCoord.xy / screenSize) : vec4(0.0, 0.0, 0.0, 1.0);
}
