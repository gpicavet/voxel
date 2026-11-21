/**
 * Extract the 6 frustum planes (a, b, c, d) from a column-major view-projection matrix.
 * A point p is inside a plane when a*p.x + b*p.y + c*p.z + d >= 0.
 * @param {Float32Array} out 24 floats
 * @param {mat4} m
 */
export function frustumPlanes(out, m) {
    // row i of the matrix = (m[i], m[4 + i], m[8 + i], m[12 + i])
    for (let p = 0; p < 6; p++) {
        const row = p >> 1;          // left/right -> x, bottom/top -> y, near/far -> z
        const sign = (p & 1) ? -1 : 1;
        out[p * 4 + 0] = m[3] + sign * m[row];
        out[p * 4 + 1] = m[7] + sign * m[4 + row];
        out[p * 4 + 2] = m[11] + sign * m[8 + row];
        out[p * 4 + 3] = m[15] + sign * m[12 + row];
    }
    return out;
}

/**
 * Conservative test: false only when the axis aligned box [min, max] is fully outside one plane.
 */
export function aabbInFrustum(planes, min, max) {
    for (let p = 0; p < 24; p += 4) {
        const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
        // corner of the box the furthest along the plane normal
        const x = a > 0 ? max[0] : min[0];
        const y = b > 0 ? max[1] : min[1];
        const z = c > 0 ? max[2] : min[2];
        if (a * x + b * y + c * z + d < 0) {
            return false;
        }
    }
    return true;
}
