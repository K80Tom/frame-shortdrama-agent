---
name: acheng-scene-design-adapter
description: Route the external scene-concept-art-director specialist into Acheng assets without creating a second production truth.
metadata:
  version: "4.0.2"
---

# Acheng Scene Design Adapter

For a scene-reference or edit/rebuild decision, use the relevant section of [the assets decision guide](../../../references/decisions/assets.md). Keep this branch advisory; do not repeat completed decisions or infer unseen geometry as approved fact.

For unresolved surface separation, light motivation or medium-specific texture, use assets A5 and the [visual reference library](../../../references/116-visual-reference-library.md). Name the existing surface, source and visible scale; pass the proposed wording to assets in the original advisory artifact. Library text is not a scene image, a new STYLE_MOTHER or permission to change topology, weather or approved geometry.

This nested specialist belongs to the assets branch. Load it only when the request explicitly needs scene design, environment concept art, a background plate, a scene repair, a multi-view scene package, or a moodboard-to-scene handoff.

Read `references/105-scene-design-adapter-v4.md` first, then load the external `scene-concept-art-director` skill and only the route-specific references it names. In the bundled package its preserved specialist entry is under `modules/assets/scene-design/external/SKILL.md`; an installed external copy may be used when that path is absent. If the external skill or its `scene-art-v1` contract is unavailable, return `EXECUTION_BLOCKED` with the missing path; do not silently fall back to an unstructured prompt.

The adapter accepts brief/moodboard/scene facts and returns a hashed `scene_art_direction.json`, standalone image prompt artifacts, upload mapping, and evidence. `write_paths` stays empty. The assets owner validates references, versions and geometry, then may merge approved facts into asset cards and `scene_registry`. Shots, effects, model and continuity retain their own owners.

The adapter does not call paid media models, edit `production.json`, create a second STYLE_MOTHER, or write H3 fields. It keeps `visual_status=UNVERIFIED` until a real image is manually reviewed.
