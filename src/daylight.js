import { vec3 } from "gl-matrix";

// Day and night: position and color of the sun and of the moon.

const LATITUDE = 35 * Math.PI / 180; // the sun culminates at 55 degrees, towards -y (south)
const SUN_INTENSITY = 3.0;            // sun light reaching the ground at noon (linear units of the shaders)
const MOON_INTENSITY = 0.05;          // moonlight, relative to the sun
const NIGHT_EXPOSURE = 6.0;

// Optical depth of the atmosphere at the zenith (scattering coefficient x scale height), per color channel:
// Rayleigh (blue sky, red sunsets), Mie (haze of a clear sky) and ozone. Same constants as sky_lut_fragment.glsl.
const RAYLEIGH_DEPTH = [5.802e-3 * 8, 13.558e-3 * 8, 33.1e-3 * 8];
const MIE_DEPTH = 0.0044 * 1.2;
const OZONE_DEPTH = [0.65e-3 * 15, 1.881e-3 * 15, 0.085e-3 * 15];

/** direction towards the sun for an hour angle (0 = noon, -pi/2 = sunrise, pi/2 = sunset) */
export function sunDirection(out, hourAngle) {
    const c = Math.cos(hourAngle);
    return vec3.set(out, Math.sin(hourAngle), -c * Math.sin(LATITUDE), c * Math.cos(LATITUDE));
}

/** fraction of each color channel of a light that crosses the atmosphere from direction dir down to the ground */
export function atmosphereTransmittance(out, dir) {
    const elevation = Math.asin(Math.max(-1, Math.min(1, dir[2]))) * 180 / Math.PI;
    const zenith = 90 - Math.max(0, elevation);
    // relative air mass (Kasten & Young 1989): 1 at the zenith, about 38 at the horizon
    const airMass = 1 / (Math.cos(zenith * Math.PI / 180) + 0.50572 * Math.pow(96.07995 - zenith, -1.6364));
    // below the horizon the body sets behind the terrain of the planet: fade out over a degree or two
    const visible = Math.min(1, Math.max(0, (elevation + 2) / 3));
    for (let i = 0; i < 3; i++) {
        out[i] = Math.exp(-(RAYLEIGH_DEPTH[i] + MIE_DEPTH + OZONE_DEPTH[i]) * airMass) * visible;
    }
    return out;
}

/**
 * Lighting for an hour angle.
 * The main light, that casts the shadows, is the sun by day and the moon by night.
 */
export function daylight(state, hourAngle) {
    sunDirection(state.sunDir, hourAngle);
    vec3.negate(state.moonDir, state.sunDir);

    atmosphereTransmittance(state.sunColor, state.sunDir);
    vec3.scale(state.sunColor, state.sunColor, SUN_INTENSITY);
    atmosphereTransmittance(state.moonColor, state.moonDir);
    vec3.multiply(state.moonColor, state.moonColor, [0.75 * MOON_INTENSITY, 0.85 * MOON_INTENSITY, 1.0 * MOON_INTENSITY]);
    vec3.scale(state.moonColor, state.moonColor, SUN_INTENSITY);

    // switch to the moon a bit after sunset, when both are dim
    const night = state.sunDir[2] < -0.05;
    vec3.negate(state.lightDir, night ? state.moonDir : state.sunDir);
    vec3.copy(state.lightColor, night ? state.moonColor : state.sunColor);

    // the moon lights the sky too (a faint copy of the day sky)
    state.moonSky = state.moonDir[2] > -0.1 ? 0.012 : 0;
    const day = smoothstep(-0.12, 0.08, state.sunDir[2]);
    state.exposure = NIGHT_EXPOSURE + (1 - NIGHT_EXPOSURE) * day;
    state.starVisibility = 1 - smoothstep(-0.15, -0.02, state.sunDir[2]);
    return state;
}

export function createDaylight() {
    return {
        sunDir: vec3.create(), moonDir: vec3.create(), lightDir: vec3.create(),
        sunColor: vec3.create(), moonColor: vec3.create(), lightColor: vec3.create(),
        moonSky: 0, exposure: 1, starVisibility: 0,
    };
}

/** "08:15" for an hour angle */
export function clockTime(hourAngle) {
    const hours = ((hourAngle / (2 * Math.PI)) * 24 + 12 + 240) % 24;
    const h = Math.floor(hours), m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
