Simple voxel engine using WebGL.

Using Ray-traced shadows.

The world is 28 800 x 28 800 voxels (450 x 450 chunks of 64^3) and 256 high: mountains up to 120 above the ground,
128 of underground with tunnels and caverns. Chunks are generated and meshed in web workers and loaded around the camera.

Day and night cycle with a physical sky (Rayleigh and Mie scattering), sun and moon shadows, voxel clouds drifting with
the wind and casting shadows, light shafts (god rays) and valley mist. Realistic textures (512 x 512, albedo and normal map) generated on the GPU at startup.

Controls: arrows to move and turn, `z` / `s` to look up and down, `space` to blow up the terrain,
`t` (held) to fast-forward time, `w` to change the weather, `g` to switch the light shafts,
`+` / `-` to change the view distance, `c` to switch the cave culling, `h` to switch the shadows between half and full resolution.
The camera collides with the voxels and slides along them.
The overlay shows fps, GPU time (when `EXT_disjoint_timer_query_webgl2` is available), visible chunks, loaded columns and triangles drawn.

Build: `npm run dist` (the worker is bundled first, then inlined in `dist/main.js`), or `npm run dev`.

<a href="https://htmlpreview.github.io/?https://github.com/gpicavet/voxel/blob/main/dist/index.html">DEMO</a>
