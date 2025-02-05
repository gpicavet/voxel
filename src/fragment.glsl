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
    for (int i = 0; i < maxSteps; i++) { 
        pos -= lightDir * 0.5; // Petit pas
        // normalise la coord tex entre 0 et 1
        vec3 stu = pos + terrainOffset;
        stu = vec3(stu.x / terrainDim.x, stu.y / terrainDim.y, stu.z / terrainDim.z);
        if (texture(terrainTex, stu).r > 0u) { // Si un voxel est rencontré
            return 0.2; // Ombre 
        }
    }
    
    return 1.0; // Pas d'obstruction = pas d'ombre
}

void main() {

    float shadow = castShadowRay(vPosition,lightDir);

    vec3 color = vColor * 0.2 + vColor * 0.8 * shadow;

    fragColor = vec4(color, 1);
}