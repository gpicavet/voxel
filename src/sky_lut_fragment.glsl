#version 300 es
precision highp float;

// Sky radiance for every direction, by single scattering in the atmosphere (Rayleigh and Mie), lit by the sun and
// faintly by the moon. Rendered into a small texture whenever the sun moves; the sky, the fog and the ambient
// light read it. Azimuth on x (world), elevation on y, with more texels near the horizon.

uniform vec3 sunDir;
uniform vec3 moonDir;
uniform float moonSky;  // moonlight on the sky, relative to the sun
uniform vec2 lutSize;

out vec4 fragColor;

const float PI = 3.14159265;
const float R_GROUND = 6360.0; // km
const float R_TOP = 6460.0;
const float VIEWER_ALTITUDE = 0.2;
const vec3 RAYLEIGH = vec3(5.802, 13.558, 33.1) * 1e-3; // scattering, km^-1 (same constants as daylight.js)
const float H_RAYLEIGH = 8.0;
const float MIE_SCATTERING = 0.004;                      // haze of a clear sky
const float MIE_EXTINCTION = 0.0044;
const float H_MIE = 1.2;
const float MIE_G = 0.8;
const vec3 OZONE = vec3(0.65, 1.881, 0.085) * 1e-3;     // absorption, in a layer around 25 km
const float SKY_INTENSITY = 14.0;
const vec3 AIRGLOW = vec3(0.0004, 0.0007, 0.0016);       // night sky without moon
const int VIEW_STEPS = 32;
const int LIGHT_STEPS = 8;

vec3 extinction(float h) {
    return RAYLEIGH * exp(-h / H_RAYLEIGH) + MIE_EXTINCTION * exp(-h / H_MIE) + OZONE * max(0.0, 1.0 - abs(h - 25.0) / 15.0);
}

// distance to the far side of a sphere centered on the planet, from inside
float exitSphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd), c = dot(ro, ro) - r * r;
    return -b + sqrt(max(b * b - c, 0.0));
}

// distance to the ground, or -1
float hitGround(vec3 ro, vec3 rd) {
    float b = dot(ro, rd), c = dot(ro, ro) - R_GROUND * R_GROUND;
    float d = b * b - c;
    if(d < 0.0) return -1.0;
    float t = -b - sqrt(d);
    return t > 0.0 ? t : -1.0;
}

vec3 transmittanceToLight(vec3 p, vec3 l) {
    if(hitGround(p, l) > 0.0) return vec3(0.0); // behind the planet
    float dt = exitSphere(p, l, R_TOP) / float(LIGHT_STEPS);
    vec3 depth = vec3(0.0);
    for(int i = 0; i < LIGHT_STEPS; i++) {
        depth += extinction(length(p + l * (float(i) + 0.5) * dt) - R_GROUND) * dt;
    }
    return exp(-depth);
}

float rayleighPhase(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
}

float miePhase(float mu) { // Cornette-Shanks
    float g2 = MIE_G * MIE_G;
    return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * mu, 1.5));
}

void main() {
    vec2 uv = gl_FragCoord.xy / lutSize;
    float azimuth = (uv.x - 0.5) * 2.0 * PI;
    float s = uv.y * 2.0 - 1.0;
    float elevation = sign(s) * s * s * 0.5 * PI;
    vec3 dir = vec3(cos(elevation) * cos(azimuth), cos(elevation) * sin(azimuth), sin(elevation));

    vec3 ro = vec3(0.0, 0.0, R_GROUND + VIEWER_ALTITUDE);
    float ground = hitGround(ro, dir);
    float tMax = ground > 0.0 ? ground : exitSphere(ro, dir, R_TOP);
    float dt = tMax / float(VIEW_STEPS);

    float muSun = dot(dir, sunDir), muMoon = dot(dir, moonDir);
    vec3 transmittance = vec3(1.0), radiance = vec3(0.0);
    for(int i = 0; i < VIEW_STEPS; i++) {
        vec3 p = ro + dir * (float(i) + 0.5) * dt;
        float h = length(p) - R_GROUND;
        float rayleigh = exp(-h / H_RAYLEIGH), mie = exp(-h / H_MIE);
        vec3 light = (RAYLEIGH * rayleigh * rayleighPhase(muSun) + MIE_SCATTERING * mie * miePhase(muSun)) * transmittanceToLight(p, sunDir);
        if(moonSky > 0.0) {
            light += moonSky * (RAYLEIGH * rayleigh * rayleighPhase(muMoon) + MIE_SCATTERING * mie * miePhase(muMoon)) * transmittanceToLight(p, moonDir);
        }
        radiance += transmittance * light * dt;
        transmittance *= exp(-extinction(h) * dt);
    }
    fragColor = vec4(radiance * SKY_INTENSITY + AIRGLOW, 1.0);
}
