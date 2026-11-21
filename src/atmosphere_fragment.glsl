#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;
precision highp sampler3D;

// Light shafts (god rays), at quarter resolution, accumulated over frames: sunlight scattered by the haze, where
// it is not blocked by the terrain or the clouds. Each frame recomputes one tile of 8x8 pixels in four (in turn,
// whole tiles keep the GPU threads coherent); the others reuse the previous result at the same place, reprojected.
// Out: the scattered light, and the distance where the view ray ends (to check the reprojection).

uniform sampler2D halfDepth;
uniform sampler2D historyScatter;
uniform sampler2D historyDepth;
uniform mat4 invViewProj;
uniform mat4 prevViewProj;
uniform vec3 camPosition;
uniform int frameIndex;
uniform bool historyValid;
uniform bool lightShafts;

layout(location = 0) out vec4 outScatter;
layout(location = 1) out vec4 outDepth;

@import ./shadow;
@import ./common;
@import ./clouds;

const float FAR = 60000.0;
const int SHAFT_STEPS = 8;
const float SHAFT_DISTANCE = 700.0;
const float HAZE_DENSITY = 0.0007; // per meter at the ground
const float HAZE_HEIGHT = 140.0;

// interleaved gradient noise: a different start for the samples of every pixel and every frame
float jitterNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float henyeyGreenstein(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

void main() {
    ivec2 size = textureSize(historyScatter, 0);
    vec2 uv = (gl_FragCoord.xy) / vec2(size);
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 farPoint = invViewProj * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(farPoint.xyz / farPoint.w - camPosition);

    // where the view ray ends: the terrain of the half resolution pass, or far away
    ivec2 halfSize = textureSize(halfDepth, 0);
    float depth = texelFetch(halfDepth, min(ivec2(uv * vec2(halfSize)), halfSize - 1), 0).r;
    float tEnd = FAR;
    if(depth < 1.0) {
        vec4 w = invViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
        tEnd = length(w.xyz / w.w - camPosition);
    }

    // previous result at the same place, if it shows the same thing (same distance where the ray ends)
    vec4 history = vec4(0.0);
    bool historyFound = false;
    if(historyValid) {
        vec4 prev = prevViewProj * vec4(camPosition + dir * min(tEnd, 20000.0), 1.0);
        vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
        if(prev.w > 0.0 && all(greaterThan(prevUv, vec2(0.0))) && all(lessThan(prevUv, vec2(1.0)))) {
            float prevEnd = texture(historyDepth, prevUv).r;
            if(abs(prevEnd - tEnd) < 0.1 * tEnd + 1.0) {
                history = texture(historyScatter, prevUv);
                historyFound = true;
            }
        }
    }
    outDepth = vec4(tEnd, 0.0, 0.0, 1.0);
    ivec2 tile = ivec2(gl_FragCoord.xy) >> 3;
    if(historyFound && ((tile.x & 1) + 2 * (tile.y & 1)) != frameIndex % 4) {
        outScatter = history;
        return;
    }

    float jitter = jitterNoise(gl_FragCoord.xy + float((frameIndex / 4) % 64) * 5.588238);
    vec3 toLight = -lightDir;
    float mu = dot(dir, toLight);
    vec3 scatter = vec3(0.0);
    if(lightShafts) {
        float tMax = min(tEnd, SHAFT_DISTANCE);
        float t0, t1;
        if(camPosition.z < CLOUD_BOTTOM && cloudLayer(camPosition, dir, t0, t1)) tMax = min(tMax, t0); // below the clouds
        float dt = tMax / float(SHAFT_STEPS);
        float phase = henyeyGreenstein(mu, 0.7);
        float inscatter = 0.0;
        for(int i = 0; i < SHAFT_STEPS; i++) {
            vec3 p = camPosition + dir * (float(i) + jitter) * dt;
            float haze = HAZE_DENSITY * exp(-max(p.z, 0.0) / HAZE_HEIGHT);
            float visible = coarseVisibility(p, toLight, 12);
            if(visible > 0.0) visible *= cloudShadow(p, toLight);
            inscatter += visible * haze * dt;
        }
        scatter = lightColor * phase * inscatter;
    }

    // accumulation over frames: blend with the previous result (a new sample every 4 frames)
    vec4 current = vec4(scatter, 1.0);
    outScatter = historyFound ? mix(history, current, 0.35) : current;
}
