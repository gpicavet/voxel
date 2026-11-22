// Atmosphere between the camera and a surface (terrain, trees): clouds in front when the camera is above them, haze
// of the light shafts, valley mist, distance fog, water around the camera. Needs common, clouds, cloud_shading and
// atmosphere, and the uniforms camPosition, fogDensity and reflectionPass of the including shader.
vec3 applyAtmosphere(vec3 color, vec3 position) {
    vec3 toSurface = position - camPosition;
    float dist = length(toSurface);
    vec3 viewDir = toSurface / dist;
    // clouds in front, when the camera is above them
    if(camPosition.z > CLOUD_BOTTOM) {
        vec3 cloudNormal;
        ivec3 cloudCellHit;
        float t = traceClouds(camPosition, viewDir, dist, cloudNormal, cloudCellHit);
        if(t >= 0.0) color = mix(color, shadeCloud(viewDir, cloudNormal, cloudCellHit), exp(-t / CLOUD_FADE));
    }
    // haze of the light shafts: where the sun does not reach it, lit by the sky only (isotropic scattering of the
    // upper hemisphere: about half the zenith radiance), darker than the sunlit shafts added at the end
    vec4 shafts = lightShaftsAt();
    color = mix(skyRadiance(vec3(0.0, 0.0, 1.0)) * 0.5, color, shafts.a);
    // valley mist, lit like the horizon in that direction
    float mist = reflectionPass ? 0.0 : 1.0 - exp(-mistDepth(camPosition, viewDir, dist));
    color = mix(color, skyRadiance(vec3(viewDir.xy, 0.0)), mist);
    // distance fog with the color of the sky behind the surface: far terrain melts into the horizon, and chunks
    // appear in the fog rather than at a visible edge
    float d2 = (dist * fogDensity) * (dist * fogDensity);
    float fog = 1.0 - exp(-d2 * d2 * d2); // clear up to half the view distance, thick close to it
    color = mix(color, skyRadiance(viewDir), fog);
    // camera under the water: everything fades into the water with the distance
    if(underwaterDensity > 0.0) color = mix(color, underwaterColor(), 1.0 - exp(-dist * underwaterDensity));
    // sunlit haze last: it is in the air in front, not hidden by the fog that hides the far chunks
    return color + shafts.rgb;
}
