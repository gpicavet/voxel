#version 300 es

layout(std140, column_major) uniform;

layout(location=0) in vec4 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec3 color;
        
uniform mat4 viewProj;
uniform vec3 lightDir; // Direction de la lumière (normalisée)

out vec3 vColor;
out vec3 vPosition;

void main() {
    vColor = color * dot(normal, -lightDir);
    //vColor = color;
    vPosition = position.xyz;
    gl_Position = viewProj * position;
}