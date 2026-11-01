---
name: scene-concept-art-director
description: Turn a brief, approved moodboard, or existing scene image into a structured scene-art direction contract, model-ready environment prompts, reference upload rules, multi-view continuity notes, and evidence-based visual QA. Use for film, animation, game, commercial, architectural, fantasy, sci-fi, historical, interior, landscape, and repair workflows.
metadata:
  version: "1.0.0"
  contract: "scene-art-v1"
---

# Scene Concept Art Director

This is a scene-design specialist, not a second production truth source or a general project orchestrator. It converts a brief into a reviewable scene contract and prompt artifacts. When Acheng Director is present, the scene contract is an advisory artifact: the assets owner merges approved scene facts into `scene_registry` and asset cards; shots owns shot-specific camera and framing; effects owns VFX and scale proofs; continuity owns persistent state. Do not edit another owner's production fields.

## Route the request before writing

Choose one mode and state it in the result:

- `direction`: brief or moodboard → scene-art direction contract.
- `prompt`: approved contract → one complete image prompt and upload manifest.
- `repair`: existing image or prompt → one narrow repair transaction; preserve named successful facts.
- `multi_view`: one scene → establishing, background plate, top-down/layout, elevation, keyframe, or day/weather variants with a shared continuity ledger.
- `critique`: prompt or image → rubric findings and the smallest structural repair.
- `handoff`: export the contract and prompt artifacts to Acheng assets without silently editing `production.json`.

Do not force a moodboard, STYLE_MOTHER, a hero key art image, a camera move, or a specific image model when the request does not need it.

## Inputs and assumptions

Accept a user brief, an approved `moodboard-alignment/data.json`, a production scene record, existing reference images, or a previous scene contract. Map moodboard `summary`, `palette`, `composition`, `style`, and relevant node fields into the scene contract; preserve their provenance and keep unresolved conflicts visible. A moodboard image is not automatically a STYLE_MOTHER.

Ask at most one question only when the missing answer changes the scene's purpose or spatial logic. Otherwise write labeled assumptions and continue. Never invent historical certainty, geography, ownership, measurements, or a reference file that was not supplied.

## Required contract and artifacts

Every non-critique result starts from `references/scene-contract-v1.md` and produces a `scene_art_direction.json` (or an inline object with the same fields). The contract must include:

- scene identity, revision, purpose, status, and source provenance;
- thesis, location, era/season/day phase, function, power or maintenance structure, recent event, and off-screen world;
- spatial grammar, boundaries, entrances/exits, landmarks, traversal, foreground/midground/background, and human-scale anchors;
- materials, aging, cultural logic, motifs, human use, iconic object, weather, and atmosphere;
- camera intent, composition, lighting sources and direction, color roles, and depth strategy;
- references with role, preserve, exclude, real file, approval state, and hash when available;
- generation intent, model family, input mode, execution settings, prompt status, unresolved items, and `visual_status`;
- Acheng handoff owner, consumers, frozen facts, and allowed advisory paths.

For `prompt`, `repair`, and `multi_view`, also produce a complete `*.image.txt`, `UPLOAD.md`, `index.json`, and `qa.json` when files are requested. The prompt is independent of the conversation and contains concrete spatial, material, lighting, scale, and human-use facts. Upload instructions remain outside the prompt.

`prompt_status=READY_TO_SUBMIT` means the text and required inputs are present. It never means a real image was generated or visually approved. Until a human reviews an actual output, keep `visual_status=UNVERIFIED`.

## Design method

1. State one scene thesis and one primary visual tension.
2. Choose a dominant spatial grammar and, only when justified, a secondary material or lighting grammar. Explain why they meet.
3. Design the space as something people use, maintain, control, fear, repair, worship, sell, or abandon.
4. Build foreground, midground, background, focal path, negative space, scale anchors, and an off-screen world before adding decoration.
5. Motivate light from real sources and assign a restrained color script with one focal accent.
6. Translate the contract into a model-specific prompt. Keep positive scene facts, reference preservation, exclusions, and execution settings separate.
7. Run the relevant QA rubric. If the concept is generic, make one structural change, add one grounded use detail, and remove decorative noise.

## References and model boundaries

Load only the references required by the route:

- `references/scene-contract-v1.md`: schema, status, ownership, and handoff rules for every route.
- `references/art-direction-framework.md`: thesis, cultural synthesis, material and human-use logic.
- `references/cinematic-scene-language.md`: composition, camera, lighting, color, depth, and atmosphere.
- `references/prompt-recipes.md`: model-neutral prompt assembly, variants, and repair transactions.
- `references/model-adapters.md`: provider capability differences and execution-setting separation.
- `references/multi-view-continuity.md`: shared anchors and allowed deltas across views and states.
- `references/qa-rubric.md`: critique, scoring, and final gate.
- `references/acheng-handoff.md`: Acheng ownership and moodboard-to-scene mapping.
- `references/usage-guide.md`: user-facing copy-ready templates for every scene route and Acheng collaboration path.
- `references/cloud-song-archive-case-study.md`: calibration only; never import its setting, providers, or visual facts into another project.

Do not claim that a provider supports a parameter without current evidence. Do not call a paid image or audio model unless the host and user explicitly authorize execution. Default to plan/prompt-only work.

## Continuation and revision

Long work returns `continuation_required`, `current_cursor`, completed artifact paths, and the next contract section. Resume from the cursor; do not replace the contract with a summary. A revision must name the scene, field, and preserved facts. Use a delta transaction (`CHANGE`, `PRESERVE_EXACTLY`, `REBUILD`) for image repairs and never redesign the whole scene for a local defect.

## Human-facing output

For ordinary requests show: mode, scene thesis, assumptions and blockers, contract summary, complete prompt, upload manifest, QA findings, and visual verification status. For machine requests show the full JSON, hashes, evidence, and unresolved list. Keep explanatory text outside copyable model prompts.

## Style and cultural ethics

Do not imitate a living artist, director, production designer, or studio house style as a direct target. Convert references into craft attributes. Treat culture as spatial, material, climate, labor, and ritual logic rather than a decorative sticker; flag uncertainty instead of fabricating authenticity.
