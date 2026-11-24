Simple voxel engine using WebGL.

Using Ray-traced shadows.

The world is 28 800 x 28 800 voxels (450 x 450 chunks of 64^3) and 256 high: mountains up to 120 above the ground,
128 of underground with tunnels and caverns. The height map is shaped in 3D near the surface: ledges, recesses and
overhangs on the slopes, rock outcrops on the ground, cave mouths opening on the hillsides.
Chunks are generated and meshed in web workers and loaded around the camera; beyond 384 m they are drawn with a
coarse mesh (voxels twice as large, about 7 times fewer faces). Chunks and trees hidden behind the terrain are not drawn:
their boxes are tested against the depth pre-pass with occlusion queries, the answers being used from the next frame.

Day and night cycle with a physical sky (Rayleigh and Mie scattering), sun and moon shadows, voxel clouds drifting with
the wind and casting shadows, light shafts (god rays) and valley mist. Realistic textures (512 x 512, albedo and normal map) generated on the GPU at startup.
On the surface, patches of blocks with grass or snow on all their faces and of bare earth.
Sky light propagated like in Minecraft (caves and overhangs are dark), and ray-traced ambient occlusion within 10 voxels.
Trees: 6 species (oak, spruce, birch, bush, dead tree, blossom tree in groves in the valleys) in 13 variants, made of voxels 4 times smaller than the terrain,
grown at startup in a worker (crooked trunks with roots, recursive crooked limbs, flat pads of foliage with hanging
fringes, spruces with whorls of drooping branches and a bare spire) and drawn as instances (free position, rotation, size, tint), with 3 levels of detail, high resolution bark textures (moss on the faces turned to the north, thicker low on the trunk) and
Minecraft-like pixel art foliage (leaves of a few texels, one texture per meter of foliage, holes cut out up close; several tones per tree, one per pad of leaves; up close, a fringe of leaves breaking the outline of the voxels), leaves fluttering in the wind inside their texture (each leaf moving and turning with its own phase, gusts) and a slight
sway of the whole tree, shadow maps for their shadows (and a larger one with the coarsest models for the far trees),
ambient occlusion (baked in the models, darker inside the crowns and at the foot of the trunks even in the sun, and a canopy map darkening the ground under the trees and the forest around),
and reflections in the water; explosions destroy them.
Lakes in the valleys (sea level 28) with planar reflections (rendered only where the water is seen, with the shadows of the camera where it sees the same surface), waves, Fresnel, sun glint, depth-based transparency (turbid: the bed fades out within a few meters) and an
underwater view; craters dug next to the water fill up.

Controls: arrows to move and turn, `z` / `s` to look up and down, `space` to blow up the terrain,
`t` (held) to fast-forward time, `w` to change the weather, `g` to switch the light shafts,
`+` / `-` to change the view distance, `c` to switch the cave culling, `o` the occlusion culling, `h` to switch the shadows between half and full resolution.
`v` writes the current view into the URL (`#pos=x,y,z&look=yaw,pitch&time=hours`, add `&pause` to stop the time): reload or share it to come back to the same view.
The camera collides with the voxels and slides along them.
The overlay shows fps, GPU time (when `EXT_disjoint_timer_query_webgl2` is available), visible chunks, loaded columns and triangles drawn.

Build: `npm run dist` (the worker is bundled first, then inlined in `dist/main.js`), or `npm run dev`.

<a href="https://htmlpreview.github.io/?https://github.com/gpicavet/voxel/blob/main/dist/index.html">DEMO</a>
