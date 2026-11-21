#version 300 es
precision highp float;
precision highp int;
precision lowp usampler3D;
precision highp sampler2D;

// One shadow ray per half resolution pixel, written to the shadow mask read by the color pass:
// r = lit (1) or in the shadow (0), g = face direction + 1 (0 = sky), b = face plane coordinate modulo 256.
uniform sampler2D halfDepth;
uniform sampler2D halfFace;
uniform mat4 invViewProj;
uniform vec3 lightDir;

out vec4 fragMask;

@import ./shadow;

const vec3 NORMALS[6] = vec3[6](
    vec3(1, 0, 0), vec3(-1, 0, 0),
    vec3(0, 1, 0), vec3(0, -1, 0),
    vec3(0, 0, 1), vec3(0, 0, -1));

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int face = int(texelFetch(halfFace, p, 0).r * 255.0 + 0.5) - 1;
    if(face < 0) {
        fragMask = vec4(1.0, 0.0, 0.0, 1.0); // sky
        return;
    }
    vec3 normal = NORMALS[face];
    vec3 sunDir = -lightDir;

    // world position of the surface, from the depth buffer
    float depth = texelFetch(halfDepth, p, 0).r;
    vec2 ndc = (vec2(p) + 0.5) / vec2(textureSize(halfDepth, 0)) * 2.0 - 1.0;
    vec4 world = invViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
    vec3 pos = world.xyz / world.w;
    // voxel faces lie on integer planes: snapping removes the depth buffer imprecision along the normal,
    // which would otherwise start the ray inside the voxel and shadow the face itself
    int axis = face >> 1;
    pos[axis] = floor(pos[axis] + 0.5);

    float lit = dot(normal, sunDir) > 0.0 ? castShadowRay(pos + normal * 1e-3, sunDir) : 0.0;
    fragMask = vec4(lit, float(face + 1) / 255.0, mod(pos[axis], 256.0) / 255.0, 1.0);
}
