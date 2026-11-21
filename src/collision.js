// Collisions of an axis aligned box with the voxels.
// The box is moved one axis at a time: on a blocked axis it stops against the voxel face,
// the other axes keep their motion, so it slides along walls and floors.
// Each axis move tests every voxel layer swept by the box, so a fast move cannot tunnel through a thin wall.

const EPS = 1e-4; // gap kept between the box and the voxel it rests against

/**
 * @param world anything with getVoxel(x, y, z) in world coordinates (> 0 means solid)
 * @param pos box center, updated in place
 * @param delta wanted move
 * @param half box half extents
 * @returns per axis, true when the move was blocked
 */
export function moveWithCollisions(world, pos, delta, half) {
    if (overlapsSolid(world, pos, half)) {
        // already inside the terrain (spawned in a voxel): no collision, so the box can get out
        for (let a = 0; a < 3; a++) pos[a] += delta[a];
        return [false, false, false];
    }
    return [0, 1, 2].map(axis => moveAxis(world, pos, axis, delta[axis], half));
}

/** first and last voxel index covered by the box along axis a */
function cellRange(pos, half, a) {
    return [Math.floor(pos[a] - half[a]), Math.ceil(pos[a] + half[a]) - 1];
}

export function overlapsSolid(world, pos, half) {
    const [x0, x1] = cellRange(pos, half, 0);
    const [y0, y1] = cellRange(pos, half, 1);
    const [z0, z1] = cellRange(pos, half, 2);
    for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
            for (let z = z0; z <= z1; z++)
                if (world.getVoxel(x, y, z) > 0) return true;
    return false;
}

/** is there a solid voxel in layer c of the axis, inside the box cross-section? */
function layerSolid(world, pos, half, axis, c) {
    const u = axis === 0 ? 1 : 0;
    const v = axis === 2 ? 1 : 2;
    const [u0, u1] = cellRange(pos, half, u);
    const [v0, v1] = cellRange(pos, half, v);
    const cell = [0, 0, 0];
    cell[axis] = c;
    for (let i = u0; i <= u1; i++) {
        for (let j = v0; j <= v1; j++) {
            cell[u] = i;
            cell[v] = j;
            if (world.getVoxel(cell[0], cell[1], cell[2]) > 0) return true;
        }
    }
    return false;
}

function moveAxis(world, pos, axis, d, half) {
    if (d > 0) {
        const front = pos[axis] + half[axis];
        const target = front + d;
        // layers c the front face enters: [c, c + 1] with c < target
        for (let c = Math.floor(front); c < target; c++) {
            if (layerSolid(world, pos, half, axis, c)) {
                pos[axis] = c - EPS - half[axis];
                return true;
            }
        }
    } else if (d < 0) {
        const back = pos[axis] - half[axis];
        const target = back + d;
        for (let c = Math.ceil(back) - 1; c + 1 > target; c--) {
            if (layerSolid(world, pos, half, axis, c)) {
                pos[axis] = c + 1 + EPS + half[axis];
                return true;
            }
        }
    }
    pos[axis] += d;
    return false;
}
