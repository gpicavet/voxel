// Shadows of the clouds from the transmittance texture of cloud_shadow_fragment.glsl (soft, cheaper than the cells),
// the cells themselves (cloudShadow) outside of it. Needs clouds.
uniform sampler2D cloudShadowTex;
uniform vec3 cloudShadowArea; // world xy of the corner of the texture at the bottom of the clouds, size

float cloudShadowSoft(vec3 p, vec3 toLight) {
    if(toLight.z <= 0.0 || cloudCoverage <= 0.0 || p.z > CLOUD_TOP) return 1.0;
    vec2 u = p.xy + toLight.xy * ((CLOUD_BOTTOM - p.z) / toLight.z);
    vec2 uv = (u - cloudShadowArea.xy) / cloudShadowArea.z;
    if(any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return cloudShadow(p, toLight);
    return texture(cloudShadowTex, uv).r;
}
