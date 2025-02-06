#version 300 es
precision highp float;
precision lowp usampler3D;

uniform usampler3D terrainTex;
uniform vec3 lightDir; // Direction de la lumière (normalisée)
uniform vec3 terrainOffset; // offset pour la texture
uniform vec3 terrainDim; // dim pour la texture

in vec3 vColor;
in vec3 vPosition;

out vec4 fragColor;

float castShadowRay(vec3 startPos, vec3 lightDir) {
    int maxSteps = 200;
    vec3 pos = startPos;

    // On avance pas à pas dans la direction de la lumière
    for(int i = 0; i < maxSteps; i++) {
        pos -= lightDir * 0.99f; // Petit pas
        // normalise la coord tex entre 0 et 1
        vec3 stu = pos + terrainOffset;
        stu = vec3(stu.x / terrainDim.x, stu.y / terrainDim.y, stu.z / terrainDim.z);
        if(stu.z < 1.0f && texture(terrainTex, stu).r > 0u) { // Si un voxel est rencontré
            return 0.2f; // Ombre 
        }
    }

    return 1.0f; // Pas d'obstruction = pas d'ombre
}

void main() {

    float shadow = castShadowRay(vPosition, lightDir);

    vec3 color = vColor * 0.2f + vColor * 0.8f * shadow;

    fragColor = vec4(color, 1);
}