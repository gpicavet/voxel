// World layout, shared by the main thread and the workers.

export const CHUNK_POW = 6;
export const CHUNK_SIZE = 1 << CHUNK_POW; // 64

// 450 x 450 chunks of 64 = 28 800 voxels per side (50 times the 9 x 9 chunks of the first version)
export const WORLD_CHUNKS = 450;
export const COLUMN_MIN = -WORLD_CHUNKS / 2;    // column coordinates, inclusive
export const COLUMN_MAX = WORLD_CHUNKS / 2 - 1;
export const WORLD_MIN_XY = COLUMN_MIN * CHUNK_SIZE;
export const WORLD_MAX_XY = (COLUMN_MAX + 1) * CHUNK_SIZE; // exclusive

// a column is 4 chunks high: underground from -128 to 0, relief from 0 to 128
export const CZ_MIN = -2;
export const CZ_MAX = 1;
export const CHUNKS_PER_COLUMN = CZ_MAX - CZ_MIN + 1;
export const WORLD_BOTTOM = CZ_MIN * CHUNK_SIZE; // below: solid rock
export const WORLD_TOP = (CZ_MAX + 1) * CHUNK_SIZE; // above: air
// bottom layers that caves and explosions never remove (nothing is drawn below them)
export const BEDROCK_TOP = WORLD_BOTTOM + 4;

// water: the air below this level and above the generated ground is water (lakes in the valleys, ~17 % of the world)
export const SEA_LEVEL = 28;

// highest possible surface, below WORLD_TOP so that mountains are never cut
export const MAX_HEIGHT = 120;

export const SEED = 'voxel';

// voxel storage: 1 bit per voxel, bytes of 2x2x2 voxels ("bricks"), x varying fastest.
// The same layout is uploaded as is into the shadow texture.
export const BRICKS = CHUNK_SIZE >> 1; // 32 bricks per chunk side
export const BRICK_BYTES = BRICKS * BRICKS * BRICKS;
export const COARSE_POW = 3; // coarse occupancy: 1 byte per 8x8x8 voxels
export const COARSE = CHUNK_SIZE >> COARSE_POW;
export const COARSE_BYTES = COARSE * COARSE * COARSE;

export function columnKey(cx, cy) {
    return (cx - COLUMN_MIN) * WORLD_CHUNKS + (cy - COLUMN_MIN);
}

export function insideWorld(cx, cy) {
    return cx >= COLUMN_MIN && cx <= COLUMN_MAX && cy >= COLUMN_MIN && cy <= COLUMN_MAX;
}
