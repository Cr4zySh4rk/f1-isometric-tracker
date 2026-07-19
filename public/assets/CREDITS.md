# Assets

## Car model

The app renders cars with a **procedural low-poly Formula-style model** built at
runtime from three.js primitives (`src/scene/cars.js`): tapered body, nose cone,
front/rear wings, airbox, halo and four wheels. Each car's body is tinted with
the driver's `team_colour` and carries a floating acronym label. This path has
**no external asset dependency** and is the shipped default.

### Optional CC0 glTF override

If you drop a CC0-licensed low-poly car model here as `car.glb`, the app will
detect it (HEAD probe in `src/main.js`), load it via three.js `GLTFLoader`,
clone it per driver and tint the body with the team colour automatically
(`buildCarFromGLTF`). No code change needed.

Good CC0 sources:
- Kenney "Car Kit" / "Racing Kit" — https://kenney.nl/assets (CC0 1.0)
- Poly Pizza CC0 vehicles — https://poly.pizza

At build time no CC0 glTF was bundled (Kenney does not publish stable per-file
`.glb` URLs suitable for automated fetch; the kits ship as zip downloads). The
procedural model is used. To add one: download a kit, export/pick a `.glb`,
place it here as `car.glb`, and add its attribution below.

| File | Source | License |
|------|--------|---------|
| _(none bundled)_ | procedural (three.js primitives) | n/a |
