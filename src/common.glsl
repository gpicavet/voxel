// Shared by the terrain and the sky shaders. Colors are linear; toneMap converts to the screen.

uniform sampler2D skyLUT; // sky radiance per direction (sky_lut_fragment.glsl)
uniform vec3 sunDir;      // towards the sun
uniform vec3 lightDir;    // direction of the main light (the sun, or the moon at night)
uniform vec3 lightColor;  // that light, once through the atmosphere
uniform float exposure;   // higher at night
uniform bool rawOutput;   // linear HDR output, no tone mapping (reflection of the water)
uniform float underwaterDensity; // > 0 when the camera is under the water: fog of the water per meter

const float PI = 3.14159265;

// valley mist: density decreasing with altitude. Kept light: the haze of the light shafts, which knows the shadows,
// does most of the work, and a uniform mist would wash out the contrast of the shafts
const float MIST_DENSITY = 0.0003;
const float MIST_BASE = 15.0;
const float MIST_HEIGHT = 28.0;

vec2 skyLUTCoord(vec3 dir) {
    float elevation = asin(clamp(dir.z, -1.0, 1.0));
    return vec2(atan(dir.y, dir.x) / (2.0 * PI) + 0.5, 0.5 + 0.5 * sign(elevation) * sqrt(abs(elevation) / (0.5 * PI)));
}

// radiance of the sky in a direction. The sky changes very fast in the last degree above the horizon (grazing rays
// cross 1000 km of air): below 1.5 degrees, and below the horizon (what the fog of distant terrain shows), the sky
// at 1.5 degrees is used, which avoids a visible line at the horizon
vec3 skyRadiance(vec3 dir) {
    float horizontal = length(dir.xy) + 1e-5;
    dir = normalize(vec3(dir.xy + 1e-5, max(dir.z, 0.026 * horizontal))); // tan(1.5 degrees) = 0.026
    return texture(skyLUT, skyLUTCoord(dir)).rgb;
}

// ambient light received by a surface: the sky from above (irradiance ~ pi x mean radiance, from a few directions
// of the sky texture), light bounced by the ground from below
vec3 ambientLight(vec3 normal) {
    vec2 h = normalize(sunDir.xy + 1e-4);
    vec3 sky = (2.0 * skyRadiance(vec3(0.0, 0.0, 1.0))
        + skyRadiance(vec3(h * 0.87, 0.5)) + skyRadiance(vec3(-h * 0.87, 0.5))) * 0.25 * PI * 0.35;
    vec3 ground = lightColor * max(-lightDir.z, 0.0) * 0.06;
    return mix(ground, sky, normal.z * 0.5 + 0.5);
}

// optical depth of the valley mist along a ray (analytic integral of the exponential density)
float mistDepth(vec3 origin, vec3 dir, float dist) {
    float start = MIST_DENSITY * exp(-(origin.z - MIST_BASE) / MIST_HEIGHT);
    float k = dir.z / MIST_HEIGHT;
    return abs(k) < 1e-4 ? start * dist : start * (1.0 - exp(-k * dist)) / k;
}

// color of the water seen from inside, lit by the sky and the sun or moon
vec3 underwaterColor() {
    return vec3(0.004, 0.020, 0.026) * (ambientLight(vec3(0.0, 0.0, 1.0)) + lightColor * max(-lightDir.z, 0.0)) * 4.0;
}

vec3 toneMap(vec3 color) {
    if(rawOutput) return color;
    color *= exposure;
    // ACES filmic curve (Narkowicz 2015 fit), then gamma
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    return pow(color, vec3(1.0 / 2.2));
}
