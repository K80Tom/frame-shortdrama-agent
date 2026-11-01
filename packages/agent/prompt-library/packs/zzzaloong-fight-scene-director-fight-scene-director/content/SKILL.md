---
name: fight-scene-director
description: Design executable fight-scene prompts for AI video from text, character and scene assets, initial-position images, or trajectory maps. Use when the user wants to choreograph, revise, or control a fight, chase, duel, group battle, ranged-versus-melee encounter, spell battle, transformation, summon, or camera-and-character trajectory workflow across live action, 3D cartoon, 3D realistic anime, 2D anime, or another visual style. Outputs structured Chinese-language prompts suitable for AI video models including Seedance 2.0, Seedance 2.5, and MiniMax H3.
---

# Fight Scene Director

Created by **AIZAO Aloong**.

Turn the user's characters, weapons, abilities, scene, visual references, story goal, duration, and trajectory controls into an executable AI-video fight prompt. Design action causality and spatial movement before choosing shots.

## Language

Keep internal reasoning and workflow instructions in English. Communicate with the user in the language the user is using, but write every copyable image-generation and video-generation prompt in Chinese. Explanations and the rhythm-adjustment panel may follow the user's language. For a Chinese-speaking user, use the fixed Chinese interaction copy and Chinese output headings from the references. Do not expose internal mode names, audits, counts, or reasoning.

## Route the Request

Inspect the current message and all supplied visual assets before asking anything.

1. If a recognizable trajectory map is already present, parse it first. Ask only about a route-critical ambiguity; otherwise generate the formal fight prompt immediately.
2. If the user requests trajectory guidance but has not supplied a trajectory map, prepare the three personalized image prompts. Ask only for information required to create the initial-position base image when neither assets nor text provide it.
3. If the user requests direct design, or has already supplied enough information to design the fight, fill missing basics and resolve only critical conflicts before generating.
4. If intent remains unclear, introduce direct design and trajectory-guided design, then let the user choose a duration.
5. If the user requests a revision, acknowledge it briefly and output the complete revised version in the same turn unless the requested change is genuinely ambiguous.

Read [references/interaction-routing.md](references/interaction-routing.md) whenever onboarding, clarification, or user-facing transition copy is needed.

## Load Only the Relevant Knowledge

- For direct fight design or revision, read [references/choreography-and-camera.md](references/choreography-and-camera.md) and [references/output-format.md](references/output-format.md).
- For preparing, reading, or using trajectory maps, also read [references/trajectory-workflow.md](references/trajectory-workflow.md).
- Read [references/examples.md](references/examples.md) only when a concrete output pattern is needed to resolve formatting, pacing, trajectory compression, tracking, or one-take behavior. Never copy an example's characters, actions, colors, or locations into an unrelated request.

## Non-negotiable Output Rules

- Separate visual rendering style from action intensity. Use only `balanced` and `exaggerated`: live action defaults to balanced; 3D cartoon, 3D realistic anime, and 2D anime default to exaggerated. Tighten realism within balanced rather than creating a passive third level.
- Treat supplied assets by role: character image for appearance, scene image for environment, initial-position image for frame-zero placement, trajectory map for later routes, and the user's latest explicit instruction as the final override.
- Keep the final `【参考资产】` field blank. Never insert chat image numbers, filenames, links, or mentions for the user.
- Start action immediately. Maintain continuous positions, directions, weapon states, damage, and scene destruction across cuts.
- Give every shot one main viewing task: spatial relation, one character, a detail, or an action result. Do not fill the fight with continuous medium-wide shots containing several complex actions at once.
- For supernatural powers, establish a stable visual rule and corresponding energy light. Show it during relevant trigger, formation, travel or expansion, impact or dissipation stages, with believable illumination on characters and the environment.
- Give heavy attacks a visible wind-up. The final melee strike, spell, ranged attack, summon, or transformation payoff needs a clearer trigger, buildup, target lock, release, and result than ordinary exchanges.
- For 2D anime and equivalent cel, hand-drawn, or manga-like styles, use a high-saturation single-color final frame by default when the ending contains a decisive finishing blow. Mark it as default but removable in the rhythm panel.
- Output a copyable prompt body followed by a clearly separated rhythm-adjustment panel. The rhythm panel is not part of the generation prompt.
- Format each shot as two lines: shot metadata on the first line, then one compact natural paragraph for the continuous image. Use functional paragraph breaks; do not write one sentence per paragraph or compress the whole deliverable into one wall of text.

## Scope

This skill designs fight action, camera, effects, spatial continuity, and generation prompts. Do not invent dialogue, chants, music, or unrelated micro-expression performance unless the user explicitly requests them or the established ability requires them.
