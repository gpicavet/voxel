#version 300 es
precision highp float;
precision highp int;

// Generates one layer of the voxel textures (run once at startup, textures.js): realistic, tileable (every noise is
// periodic over the texture), with a relief turned into a normal map. Layers: 0 earth, 1 rock, 2 grass, 3 snow, 4 sand,
// 5 water ripples (only its normal map is used, by water_fragment.glsl), and for the trees: 6 oak bark, 7 birch bark,
// 8 dead wood, 9 spruce bark (the foliage is pixel art: leafTextures.js).

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

// Cellular noise with stretched cells (period cells along x and y, periodic): distance, in texture units, to the nearest
// border between two cells (the borders of the cells as drawn, a straight line between each pair: cracks of the same
// width whatever their direction), and an id of the cell. round (texture units) rounds the corners of the cells: the
// borders are merged with a smooth minimum, so the cracks widen where they meet.
vec2 cells(vec2 uv, vec2 period, float round) {
    vec2 p = uv * period;
    vec2 i = floor(p), f = fract(p);
    vec2 o1 = vec2(0.0), c1 = vec2(0.0);
    float best = 8.0;
    for(int y = -1; y <= 1; y++) {
        for(int x = -1; x <= 1; x++) {
            vec2 cell = mod(i + vec2(x, y), period);
            vec2 o = vec2(x, y) + hash2(cell) - f;
            float d = dot(o, o);
            if(d < best) {
                best = d;
                o1 = o;
                c1 = cell;
            }
        }
    }
    float border = 8.0, sum = 0.0;
    for(int y = -2; y <= 2; y++) {
        for(int x = -2; x <= 2; x++) {
            vec2 o = vec2(x, y) + hash2(mod(i + vec2(x, y), period)) - f;
            vec2 n = o - o1;
            if(dot(n, n) < 1e-6) continue;
            // the border is the line half way between the two points in cell units; its distance in texture units
            float d = dot(0.5 * (o1 + o), n) / length(n * period);
            border = min(border, d);
            sum += exp(-d / max(round, 1e-6));
        }
    }
    if(round > 0.0) border = min(border, -round * log(sum));
    return vec2(max(border, 0.0), hash(c1 + 7.3));
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
        // soft: a narrow range of browns
        albedo = mix(vec3(0.20, 0.13, 0.08), vec3(0.31, 0.21, 0.13), lumps * 0.7 + grain * 0.3);
        albedo = mix(albedo, vec3(0.29, 0.24, 0.19) * (0.9 + 0.15 * w.z), pebble * 0.5);
        albedo *= 0.86 + 0.2 * height;
        return height;
    }
    if(layer == 1) {
        // rock: horizontal strata, bumps, fine grain, lichen (no cracks)
        float strata = fbm(uv, vec2(2.0, 20.0), 5);
        float bumps = fbm(uv, vec2(10.0), 6);
        float height = bumps * 0.6 + strata * 0.4;
        float tone = fbm(uv, vec2(24.0), 4) * 0.45 + strata * 0.55;
        albedo = mix(vec3(0.13, 0.125, 0.12), vec3(0.32, 0.305, 0.29), tone);
        albedo *= 0.88 + 0.24 * vnoise(uv, vec2(128.0)); // grain
        float lichen = smoothstep(0.64, 0.78, fbm(uv + 0.5, vec2(10.0), 5));
        albedo = mix(albedo, vec3(0.29, 0.31, 0.18), lichen * 0.4);
        return height;
    }
    if(layer == 2) {
        // grass: blades (fine streaks), clumps, yellowed patches, a little bare earth
        float blades = vnoise(uv, vec2(192.0, 64.0)) * 0.6 + vnoise(uv + 0.3, vec2(64.0, 192.0)) * 0.4;
        float clumps = fbm(uv, vec2(16.0), 4);
        float patches = smoothstep(0.55, 0.8, fbm(uv, vec2(4.0), 4));
        float height = blades * 0.55 + clumps * 0.45;
        // soft: a narrow range of greens, faint yellowed patches and bare earth
        albedo = mix(vec3(0.08, 0.18, 0.04), vec3(0.14, 0.31, 0.06), clumps * 0.5 + blades * 0.5);
        albedo = mix(albedo, vec3(0.30, 0.33, 0.10), patches * 0.3);
        float bare = smoothstep(0.82, 0.92, vnoise(uv, vec2(40.0)));
        albedo = mix(albedo, vec3(0.24, 0.17, 0.10), bare * 0.3);
        albedo *= 0.88 + 0.24 * blades;
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
    if(layer == 6) {
        // oak bark: long ridges of rough gray bark split by deep dark furrows, that wander, part and join again (cells
        // 5 times taller than wide), ragged edges, mottled, gray-green lichen on the ridges. The furrows run along v:
        // along the branch (tree_surface.glsl)
        vec2 w = uv + vec2((fbm(uv, vec2(2.0, 3.0), 3) - 0.5) * 0.10 + (fbm(uv + 0.5, vec2(6.0, 5.0), 3) - 0.5) * 0.035, 0.0);
        vec2 c = cells(w, vec2(14.0, 3.0), 0.005);
        // ragged furrows, wider in places
        float edge = c.x + (fbm(uv, vec2(48.0, 20.0), 3) - 0.5) * 0.008 - (vnoise(uv, vec2(7.0, 3.0)) - 0.5) * 0.008;
        float ridge = smoothstep(0.004, 0.04, edge); // 0 at the bottom of the furrows, 1 on top of the ridges
        float streaks = fbm(uv, vec2(40.0, 6.0), 3); // fibers and flakes along the ridges
        float rough = fbm(uv, vec2(96.0, 48.0), 2);
        float height = ridge * (0.5 + 0.25 * streaks + 0.15 * rough + 0.1 * c.y);
        // gray, darker and browner down the sides of the ridges, almost black at the bottom of the furrows
        vec3 top = mix(vec3(0.17, 0.165, 0.145), vec3(0.30, 0.29, 0.265), smoothstep(0.3, 0.8, streaks * 0.6 + rough * 0.4));
        albedo = mix(vec3(0.06, 0.048, 0.036), top, smoothstep(0.1, 0.9, ridge));
        albedo = mix(albedo, vec3(0.01, 0.008, 0.006), 1.0 - smoothstep(0.0, 0.016, edge));
        albedo *= 0.85 + 0.3 * c.y;
        // mottled: darker and lighter patches across the ridges
        albedo *= mix(0.5, 1.2, smoothstep(0.25, 0.75, fbm(uv + 0.11, vec2(12.0, 6.0), 4)));
        // lichen: gray-green patches on the ridges, some yellow-green
        float lichen = smoothstep(0.55, 0.7, fbm(uv + 0.3, vec2(6.0, 4.0), 4)) * smoothstep(0.4, 0.8, ridge);
        albedo = mix(albedo, mix(vec3(0.15, 0.18, 0.10), vec3(0.21, 0.24, 0.08), vnoise(uv, vec2(20.0))) * (0.8 + 0.4 * rough), lichen * 0.7);
        return height;
    }
    if(layer == 9) {
        // spruce bark: thin rounded plates, mauve gray, a little taller than wide, separated by cracks red-brown at the
        // bottom; some plates partly split again, dotted with small pits; green lichen, a little red-orange bark where
        // plates came off
        vec2 w = uv + (vec2(fbm(uv, vec2(4.0, 3.0), 3), fbm(uv + 0.7, vec2(3.0, 4.0), 3)) - 0.5) * 0.06
            + (vec2(fbm(uv, vec2(10.0), 3), fbm(uv + 0.3, vec2(10.0), 3)) - 0.5) * 0.035;
        vec2 big = cells(w, vec2(12.0, 8.0), 0.006);
        float edge = big.x + (fbm(uv, vec2(24.0), 3) - 0.5) * 0.010;
        vec2 small = cells(w + vec2(0.13, 0.41), vec2(22.0, 15.0), 0.0);
        // partial cracks inside some plates: they fade out before crossing them
        float split = (1.0 - smoothstep(0.0, 0.003, small.x)) * smoothstep(0.5, 0.7, vnoise(w, vec2(12.0, 9.0)))
            * smoothstep(0.01, 0.03, edge) * step(0.55, big.y);
        // plates: flat, slightly domed, the edges lifted a little (they curl)
        float plate = smoothstep(0.0, 0.006, edge);
        float rim = smoothstep(0.03, 0.01, edge) * plate;
        vec3 pits = worley(uv, 56.0);
        float pit = (1.0 - smoothstep(0.06, 0.13, pits.x)) * step(0.6, pits.z) * plate;
        float surface = fbm(uv, vec2(24.0, 16.0), 3);
        float height = plate * (0.7 + 0.15 * surface + 0.1 * big.y + 0.1 * rim) - split * 0.2 - pit * 0.1;
        vec3 plateColor = mix(vec3(0.11, 0.09, 0.10), vec3(0.24, 0.21, 0.21), surface * 0.5 + big.y * 0.5);
        plateColor *= 0.65 + 0.5 * fbm(uv + 0.37, vec2(30.0), 3); // mottled
        plateColor *= 1.0 + 0.15 * rim;
        // the gaps: red-brown, darker at the bottom
        vec3 gap = mix(vec3(0.03, 0.012, 0.008), vec3(0.16, 0.06, 0.035), smoothstep(0.0, 0.005, edge));
        albedo = mix(gap, plateColor, plate);
        albedo *= (1.0 - split * 0.5) * (1.0 - pit * 0.4);
        // lichen: green patches over several plates
        float lichen = smoothstep(0.56, 0.7, fbm(uv + 0.2, vec2(5.0, 4.0), 4)) * plate;
        albedo = mix(albedo, mix(vec3(0.12, 0.17, 0.05), vec3(0.19, 0.24, 0.07), vnoise(uv, vec2(30.0))), lichen * 0.7);
        // fresh red-orange bark: small patches where a plate came off
        float fresh = smoothstep(0.66, 0.72, vnoise(uv, vec2(20.0, 12.0))) * step(0.85, big.y) * plate;
        albedo = mix(albedo, vec3(0.19, 0.065, 0.04), fresh * 0.7);
        return height;
    }
    if(layer == 7) {
        // birch bark: white, horizontal dark lenticels, black patches, a little peeling
        float lenticel = smoothstep(0.78, 0.86, vnoise(uv, vec2(12.0, 90.0))) * smoothstep(0.4, 0.7, vnoise(uv + 0.2, vec2(24.0, 6.0)));
        float blotch = smoothstep(0.66, 0.74, fbm(uv, vec2(3.0, 5.0), 5));
        float grain = vnoise(uv, vec2(40.0, 160.0));
        float height = 0.6 + grain * 0.15 - lenticel * 0.4 - blotch * 0.2;
        albedo = mix(vec3(0.78, 0.76, 0.72), vec3(0.92, 0.90, 0.86), grain);
        albedo = mix(albedo, vec3(0.86, 0.72, 0.58), smoothstep(0.7, 0.8, fbm(uv + 0.6, vec2(6.0, 12.0), 3)) * 0.35); // peeling
        albedo = mix(albedo, vec3(0.06, 0.05, 0.05), max(lenticel * 0.85, blotch));
        return height;
    }
    if(layer == 8) {
        // dead wood: silver gray, fine vertical grain, a few deep cracks
        float grain = vnoise(uv, vec2(80.0, 4.0)) * 0.6 + vnoise(uv, vec2(160.0, 10.0)) * 0.4;
        float crack = smoothstep(0.035, 0.0, abs(fract(uv.x * 5.0 + (fbm(uv, vec2(2.0, 4.0), 3) - 0.5) * 0.6) - 0.5) - 0.465);
        float height = grain * 0.7 + 0.3 - crack * 0.6;
        albedo = mix(vec3(0.30, 0.28, 0.25), vec3(0.58, 0.55, 0.50), grain);
        albedo *= 1.0 - crack * 0.7;
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
    float strength = layer == 3 || layer == 4 ? 2.0 : layer == 2 ? 3.0 : layer == 0 ? 5.0 : layer == 5 ? 3.0 : 8.0;
    vec3 n = normalize(vec3((h - hx) * size * strength / 64.0, (h - hy) * size * strength / 64.0, 1.0));
    outAlbedo = vec4(albedo, 1.0);
    outNormal = vec4(n * 0.5 + 0.5, 1.0);
}
