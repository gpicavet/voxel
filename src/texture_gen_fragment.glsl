#version 300 es
precision highp float;
precision highp int;

// Generates one layer of the voxel textures (run once at startup, textures.js): realistic, tileable (every noise is
// periodic over the texture), with a relief turned into a normal map. Layers: 0 earth, 1 rock, 2 grass, 3 snow, 4 sand,
// 5 water ripples (only its normal map is used, by water_fragment.glsl).

uniform int layer;
uniform float size; // texels per side

layout(location = 0) out vec4 outAlbedo; // linear color (the sRGB target encodes it)
layout(location = 1) out vec4 outNormal; // tangent space normal * 0.5 + 0.5

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
    return vec2(hash(p), hash(p + 17.17));
}

// value noise, periodic: period cells along x and y
float vnoise(vec2 uv, vec2 period) {
    vec2 p = uv * period;
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(mod(i, period)), b = hash(mod(i + vec2(1.0, 0.0), period));
    float c = hash(mod(i + vec2(0.0, 1.0), period)), d = hash(mod(i + vec2(1.0), period));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 uv, vec2 period, int octaves) {
    float sum = 0.0, amplitude = 0.5, norm = 0.0;
    for(int i = 0; i < octaves; i++) {
        sum += amplitude * vnoise(uv, period);
        norm += amplitude;
        period *= 2.0;
        amplitude *= 0.5;
        uv += 0.37; // decorrelate the octaves
    }
    return sum / norm;
}

// cellular noise, periodic: x distance to the nearest point, y to the second, z id of the nearest cell
vec3 worley(vec2 uv, float period) {
    vec2 p = uv * period;
    vec2 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0, id = 0.0;
    for(int y = -1; y <= 1; y++) {
        for(int x = -1; x <= 1; x++) {
            vec2 cell = mod(i + vec2(x, y), period);
            float d = length(vec2(x, y) + hash2(cell) - f);
            if(d < f1) {
                f2 = f1;
                f1 = d;
                id = hash(cell + 3.1);
            } else if(d < f2) {
                f2 = d;
            }
        }
    }
    return vec3(f1, f2, id);
}

// relief (0 .. 1) and color of a material at uv
float material(vec2 uv, out vec3 albedo) {
    if(layer == 0) {
        // earth: lumps, fine grain, pebbles in some cells
        float lumps = fbm(uv, vec2(6.0), 5);
        float grain = fbm(uv, vec2(96.0), 3);
        vec3 w = worley(uv, 28.0);
        float pebble = smoothstep(0.3, 0.15, w.x) * step(0.82, w.z); // a few small stones
        float height = lumps * 0.55 + grain * 0.25 + pebble * (0.4 - w.x);
        albedo = mix(vec3(0.16, 0.10, 0.06), vec3(0.36, 0.25, 0.15), lumps * 0.7 + grain * 0.3);
        albedo = mix(albedo, vec3(0.30, 0.26, 0.21) * (0.8 + 0.3 * w.z), pebble * 0.8);
        albedo *= 0.7 + 0.45 * height;
        return height;
    }
    if(layer == 1) {
        // rock: horizontal strata, large fractured blocks with a few thin cracks, fine grain, lichen
        float strata = fbm(uv, vec2(2.0, 20.0), 5);
        float bumps = fbm(uv, vec2(10.0), 6);
        vec3 w = worley(uv, 4.0);
        // cracks only along some block edges (broken up by noise), and fainter hairline cracks
        float crack = smoothstep(0.035, 0.0, w.y - w.x) * smoothstep(0.45, 0.6, fbm(uv, vec2(8.0), 3));
        vec3 fine = worley(uv + 0.21, 16.0);
        float hairline = smoothstep(0.02, 0.0, fine.y - fine.x) * smoothstep(0.55, 0.7, fbm(uv + 0.4, vec2(12.0), 3));
        float height = bumps * 0.55 + strata * 0.35 + w.x * 0.1 - crack * 0.35 - hairline * 0.12;
        float tone = fbm(uv, vec2(24.0), 4) * 0.45 + strata * 0.55;
        albedo = mix(vec3(0.21, 0.20, 0.20), vec3(0.50, 0.48, 0.45), tone);
        albedo *= 0.9 + 0.2 * w.z; // each block a bit different
        albedo *= 0.85 + 0.3 * vnoise(uv, vec2(128.0)); // grain
        float lichen = smoothstep(0.64, 0.78, fbm(uv + 0.5, vec2(10.0), 5));
        albedo = mix(albedo, vec3(0.36, 0.38, 0.22), lichen * 0.45);
        albedo *= 1.0 - crack * 0.5 - hairline * 0.2;
        return height;
    }
    if(layer == 2) {
        // grass: blades (fine streaks), clumps, yellowed patches, a little bare earth
        float blades = vnoise(uv, vec2(192.0, 64.0)) * 0.6 + vnoise(uv + 0.3, vec2(64.0, 192.0)) * 0.4;
        float clumps = fbm(uv, vec2(16.0), 4);
        float patches = smoothstep(0.55, 0.8, fbm(uv, vec2(4.0), 4));
        float height = blades * 0.55 + clumps * 0.45;
        albedo = mix(vec3(0.05, 0.13, 0.025), vec3(0.17, 0.36, 0.07), clumps * 0.5 + blades * 0.5);
        albedo = mix(albedo, vec3(0.34, 0.36, 0.10), patches * 0.45);
        float bare = smoothstep(0.82, 0.92, vnoise(uv, vec2(40.0)));
        albedo = mix(albedo, vec3(0.25, 0.17, 0.10), bare * 0.6);
        albedo *= 0.75 + 0.5 * blades;
        return height;
    }
    if(layer == 4) {
        // sand: fine grain, ripples, a few small pebbles and darker damp patches
        float ripples = sin((uv.y + fbm(uv, vec2(3.0), 3) * 0.3) * 6.2831853 * 14.0) * 0.5 + 0.5;
        float grain = vnoise(uv, vec2(256.0));
        vec3 w = worley(uv, 36.0);
        float pebble = smoothstep(0.25, 0.12, w.x) * step(0.9, w.z);
        float height = ripples * 0.08 + grain * 0.05 + fbm(uv, vec2(8.0), 4) * 0.35 + pebble * 0.2;
        albedo = mix(vec3(0.46, 0.40, 0.28), vec3(0.60, 0.53, 0.39), fbm(uv, vec2(10.0), 4) * 0.7 + grain * 0.3);
        albedo *= 0.96 + 0.06 * ripples;
        albedo = mix(albedo, vec3(0.35, 0.33, 0.30), pebble * 0.8);
        return height;
    }
    if(layer == 5) {
        // small waves: rounded crests in all directions
        float height = fbm(uv, vec2(5.0), 5) * 0.65 + fbm(uv + 0.5, vec2(17.0), 3) * 0.35;
        albedo = vec3(0.0);
        return height;
    }
    // snow: soft drifts, wind ripples, bluish hollows
    float drifts = fbm(uv, vec2(5.0), 5);
    float ripples = vnoise(uv, vec2(8.0, 48.0));
    float height = drifts * 0.8 + ripples * 0.2;
    albedo = mix(vec3(0.70, 0.78, 0.90), vec3(0.92, 0.94, 0.97), smoothstep(0.2, 0.7, height));
    return height;
}

void main() {
    vec2 uv = gl_FragCoord.xy / size;
    vec3 albedo, unused;
    float h = material(uv, albedo);
    // normal from the relief (finite differences, wrapping around with the noise)
    float hx = material(uv + vec2(1.0 / size, 0.0), unused);
    float hy = material(uv + vec2(0.0, 1.0 / size), unused);
    float strength = layer == 3 || layer == 4 ? 2.0 : layer == 2 ? 5.0 : layer == 5 ? 3.0 : 8.0;
    vec3 n = normalize(vec3((h - hx) * size * strength / 64.0, (h - hy) * size * strength / 64.0, 1.0));
    outAlbedo = vec4(albedo, 1.0);
    outNormal = vec4(n * 0.5 + 0.5, 1.0);
}
