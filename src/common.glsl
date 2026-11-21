// Shared by the terrain and the sky shaders. Colors are linear; toneMap converts to the screen.

const vec3 SUN_COLOR = vec3(1.0, 0.92, 0.8) * 3.0;
const vec3 SKY_ZENITH = vec3(0.12, 0.3, 0.75);
const vec3 SKY_HORIZON = vec3(0.6, 0.75, 0.95);
const vec3 GROUND_BOUNCE = vec3(0.22, 0.2, 0.16);

// color of the sky seen in the direction dir (no sun disk), also used as fog color
vec3 skyColor(vec3 dir, vec3 sunDir) {
    vec3 sky = mix(SKY_HORIZON, SKY_ZENITH, sqrt(clamp(dir.z, 0.0, 1.0)));
    // below the horizon: haze
    sky = mix(sky, SKY_HORIZON * 0.8, clamp(-dir.z * 4.0, 0.0, 1.0));
    // glow around the sun
    sky += SUN_COLOR * 0.15 * pow(max(dot(dir, sunDir), 0.0), 8.0);
    return sky;
}

// ambient light received by a surface: sky from above, light bounced by the ground from below
vec3 ambientLight(vec3 normal) {
    vec3 skyAmbient = (SKY_ZENITH + SKY_HORIZON) * 0.5;
    return mix(GROUND_BOUNCE, skyAmbient, normal.z * 0.5 + 0.5);
}

vec3 toneMap(vec3 color) {
    // ACES filmic curve (Narkowicz 2015 fit), then gamma
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    return pow(color, vec3(1.0 / 2.2));
}
