#version 300 es

out vec2 vNdc;

void main() {
    // one triangle covering the screen, no vertex buffer
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
    vNdc = p;
    // on the far plane: with depthFunc LEQUAL only the pixels without terrain are shaded
    gl_Position = vec4(p, 1.0, 1.0);
}
