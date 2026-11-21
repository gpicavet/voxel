// Color of the face of a voxel cloud hit by a view ray (needs common.glsl and clouds.glsl).
vec3 shadeCloud(vec3 rd, vec3 normal, ivec3 cell) {
    vec3 toLight = -lightDir;
    // self shadow: a filled cell between this one and the light (one cell per step along the main axis)
    vec3 lc = toLight / CLOUD_CELL;
    lc /= max(max(abs(lc.x), abs(lc.y)), abs(lc.z));
    vec3 center = vec3(cell) + 0.5;
    float lit = 1.0;
    for(int k = 1; k <= 6; k++) {
        if(cloudCell(ivec3(floor(center + lc * float(k))))) {
            lit = 0.0;
            break;
        }
    }
    float ndotl = max(dot(normal, toLight), 0.0);
    // sky light, full on the tops, less on the sides and below; a neutral part, since the clouds are lit from all
    // sides by the light they scatter
    float side = normal.z > 0.5 ? 1.0 : (normal.z < -0.5 ? 0.55 : 0.8);
    vec3 sky = skyRadiance(vec3(0.0, 0.0, 1.0)) * PI * 0.5;
    vec3 ambient = mix(sky, vec3(dot(sky, vec3(0.3, 0.5, 0.2))), 0.5) * side;
    // light diffusing through the cloud (seen from below), and through the edges when looking towards the light
    float through = max(toLight.z, 0.0) * 0.45 + pow(max(dot(rd, toLight), 0.0), 8.0) * 0.6;
    return 0.95 * (lightColor * (ndotl * lit + through) + ambient);
}
