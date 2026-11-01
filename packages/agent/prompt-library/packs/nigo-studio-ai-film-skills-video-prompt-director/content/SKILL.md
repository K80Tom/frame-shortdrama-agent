---
name: video-prompt-director
description: Turn a short scene direction into one submit-ready, Seedance 2.5-optimized prompt for reference-to-video (R2V) generation. Use when the user gives a scene idea, action choreography, or shot description with reference images and wants a full video prompt built from it — reference role mapping, staged event script, camera and audio design included.
---

# Video Prompt Director

Turn the user's short scene direction into one rigorous, submit-ready prompt tuned for Seedance 2.5.

**Scope:** new video generation from text plus reference images (R2V), including fixing a first frame or a last frame. Video editing and video extension are out of scope — keep those workflows separate.

## What it does

**Input:** a few lines of scene direction from the user. Who, where, what happens. Optional: reference images, camera wishes, a first-frame or last-frame image.

**Output:** one complete English prompt the user can paste into Seedance 2.5. Nothing else — no analysis, no settings, no commentary inside the prompt.

This skill supplies the prompt craft. The direction — what the scene is, what the money moment is — stays the user's; do not override it.

## Step 1. Lock the shot contract

From the user's direction, fix these before writing:

- Subjects and their count.
- The primary action or event, in causal order.
- The space: where things are relative to each other.
- The ending state: what is visibly true when the clip ends.
- Anything the user explicitly requires or excludes.

Do not change identities, counts, event order, or outcomes. Do not invent characters, dialogue, or plot the user didn't give. If the direction is thin, fill in conservative craft details (camera, light, sound) yourself. Ask one consolidated question only when an ambiguity would change the core result — who holds the prop at the end, which way someone faces. Everything else, decide and move on.

## Step 2. Assign every reference a role

One explicit role per material, one line each. Never a range sentence covering several subjects at once.

```text
@Image 1 defines the man's facial features, hairstyle, and clothing. Do not use the image background.
@Image 2 defines the alley's walls, ground, and lighting. Do not use the people in the image.
```

Rules that prevent most multi-reference accidents:

- A material contributes only what is directly visible in it. Identity, age, relationships, and plot come from the user's text alone.
- One single-person reference must not define two characters who appear together.
- An environment reference is design material, not a fixed viewpoint. When the camera should NOT copy the reference's composition, say so: `@Image 2 is a style reference only, not a fixed keyframe; the model extends the world and the subject moves through real space.`
- Hard limits: up to 30 images, 50 materials total. Fewer distinct subjects is more stable.
- `@Image N` is resolved by upload order: it means the N-th image the user attaches at generation time. Number the roles in the order the user listed their materials, and remind them to attach in that same order on their platform.

**First frame / last frame.** To lock the exact opening image, write the standalone sentence `@Image N is the first frame.` — then describe that composition (subject position, pose, props, camera direction) in a new sentence. To lock the ending image: `@Image N is the last frame.` Do not weaken these into "reference the opening composition"; the exact sentence is what locks the frame. The first frame locks the output aspect ratio, so a first and last frame should share the same ratio. When the user wants two clips to cut together seamlessly, suggest the chaining technique: extract the last frame of the previous take and supply it as the next take's first frame.

## Step 3. Build the prompt in this structure

```text
[Generation Goal]
[Reference Material Roles]
[Subjects and Relationships]
[Event Script]
[Visual and Camera Treatment]
[Audio]
[Maintain Consistency]
```

All labels except `[Visual and Camera Treatment]` and `[Audio]` are official Seedance 2.5 section labels. Those two are our studio's extension — the official guide writes camera and audio as plain prose lines, and permits additional task-internal labels; we promote them to sections because they earn their own space in any shot worth generating. Skip a section that has nothing to say (no references → drop the reference sections), but keep the order.

**[Generation Goal]** — one or two sentences: the video type, the central subject, the primary event.

**[Subjects and Relationships]** — bind each subject to its reference and its fixed attributes. Then set the blocking the official way: describe inside/outside, front/back, facing direction, distance, and the separating structure, all relative to stable objects — doors, tables, counters, vehicles, roads — not just screen-left or screen-right. Example: `The clerk always stands on the inner side of the glass counter, facing outward; the two customers stand side by side outside the counter and speak to the clerk across it.` When several characters share the frame, separate them visibly — silhouette, hair, gear — so their features stay their own.

**[Event Script] — write it in Stages.** Each stage carries exactly one primary change and ends in an observable state:

```text
Stage 1 - <name>: Opening state: <...>. <One primary action or event>. End state: <observable state>.
Stage 2 - <name>: Continue from the previous stage. <...>. End state: <...>.
```

- Do not invent numeric time ranges to fill a target duration; durations are set at generation time. If the event list gets dense, merge stages instead of subdividing.
- When one event must not happen before another, write the trigger before the reaction inside the stage: `seeing the first man fall, the second reaches for his holster`. A reaction with no visible trigger is where causality breaks.
- Internal thoughts become visible actions, expressions, or pauses — never narration of feelings.

**[Visual and Camera Treatment]** — camera and look. Camera = shot size + movement + direction + target (`over-the-shoulder at eye level, tracking forward slowly toward the far entrance`). Light = real source + direction (`one sodium lamp overhead, hard light from above`). Tie color to surfaces and light sources rather than listing mood words. If you use a film term (dolly zoom, rack focus, shallow depth of field), also state its observable result on screen.

**[Audio]** — what is actually heard, tied to visible action. Syntax when types must be distinguished: `()` music, `<>` sound effects, `{}` dialogue, `【】` subtitles. For dialogue: the user's words are the only speakable words — never invent a full line from a described intention. Give each speaker a one-line voice description and state the language if it matters: `The man says in a low, worn voice, {Stay down.} Only the man speaks.`

**[Maintain Consistency]** — one sentence listing what must not drift: identities and clothing, prop counts and ownership, spatial orientation, the camera's side of the action.

## Step 4. Apply the craft rules

These rules are the distilled cost of our production retakes. Apply all of them, every time.

**R1. References carry identity; the prompt reinforces it in words.** Seedance 2.5 reads many reference images, and characters hold together best when the prompt backs the reference up: name the traits that must persist — hairstyle, clothing, distinguishing gear — exactly as the reference shows them, and never contradict it. This verbal reinforcement is what keeps a character stable across takes, especially with several people in frame. Scenery is the opposite case: assign the environment reference its role, then write motion *through* the space instead of re-describing its details — re-described scenery tends to get re-drawn on the prompt's terms and drift away from the reference.

**R2. Write motion, not outcomes.** Physics the model can infer ("walks toward the far door") should not be doubled with its visual result ("recedes, growing smaller"). Outcome words become performance goals and get exaggerated.

**R3. Only what the camera can see.** Anything written into the prompt tends to appear in frame. Off-screen lights, objects, and events must be expressed as their visible effect (`a band of light sweeps across the wall`) or as sound (`only the off-screen sound of a heavy door closing is heard`).

**R4. Concrete motion verbs.** Not `fight / run / move` — use `slams, pivots, lunges, staggers, drives`. Body mechanics compress into one or two film words (`with full weight transfer`); environmental physics stay specific (`concrete dust explodes radially`).

**R5. Delegate physics, fix intent.** What anyone can predict from watching (weight shift, cloth, dust) needs one or two words. What no one could guess (a feint, a deliberate miss, who is actually winning) needs one to three explicit sentences.

**R6. Interior states through visible cues.** Not a label (`he is angry`), not anatomy (muscle-by-muscle). Pick one or two: gaze, mouth, breath, a pause. When emotion shifts, give it a visible trigger first, then the reaction: `her fingers stop on the cup as the letter lands; the half-smile fades`.

**R7. Camera and light are specified, not admired.** Not `dynamic camera` but `low-angle tracking shot, camera pushes in toward the doorway`. Not `dramatic lighting` but `hard light from upper left, one practical lamp in frame`.

**R8. States, not negations.** `no gun` injects the token "gun". Write the positive state instead: `holster stays clipped, both hands empty`. To remove something from a draft, delete the sentence that caused it — don't add a "don't".

**R9. One side of the line.** Keep the camera on one side of the action axis so characters don't flip direction between stages. Blocking follows the stable-object rule in `[Subjects and Relationships]`; locking a subject to a frame edge is fine (`hard against the far left edge`).

**R10. Geometry must cohere.** Lens, shot size, subject distance, and spacing are one geometry. A 40mm lens cannot hold two people 4 m apart in a waist-up two-shot. When it doesn't work, change the shot size, not the adjectives.

**R11. Speed lives on screen, not in effort words.** "Sprints with explosive power" still reads as jogging. What works: bring the background closer, let a foreground object cross once, clip the subject at the frame edge, state motion blur.

**R12. Build the money shot with a named technique.** Decide the one moment the viewer should hold their breath, then spend the clip's time on it — and pick a technique that serves it. Popular techniques include a one-take shot, dolly zoom, aerial view, FPV, bullet time, handheld camera, and bounce speed ramp. Write it as: technique + target subject + starting state + movement direction + destination state. For a one-take, list the subjects, spaces, and events the continuous camera passes through in order. For handheld, name the subject being followed and the amount of shake. For a bounce speed ramp, state where the action accelerates, decelerates, or rebounds, and where it finally rests.

**R13. Dialogue is exact.** `{...}` marks speech; only the user's words are speakable. Intent without words becomes mouth, pause, posture — not an invented line.

**R14. End on a held state.** Give the final stage a short static hold (a settled pose, released hands, a stopped look). It protects the cut point and stops the model from inventing one more event.

## Step 5. Self-check, then deliver

- Every sentence answers "how would you shoot this?" — no mood-only lines.
- Character descriptions reinforce their references without contradicting them; scenery stays at role assignment. No outcome words, no off-screen objects, no negations.
- Every provided material has exactly one explicit role.
- Each stage has one primary change and an observable end state; triggers precede reactions.
- No parameters in the prompt: duration, aspect ratio, resolution, and fps belong in the generation settings.

Deliver the prompt body only. If the user's direction conflicts with a platform setting, add one short note *after* the prompt — never inside it.

## Sample prompt

**User's direction:** *A narrow alley, one body wide. One man takes down three pursuers, front to back. One take.* (with @Image 1 = the man, @Image 2 = an alley)

```text
[Generation Goal]
Generate a continuous one-take action video: in a narrow alley at night, one man takes down three pursuers, front to back.

[Reference Material Roles]
@Image 1 defines the man's facial features, hairstyle, and clothing. Do not use the image background.
@Image 2 defines the alley's walls, ground, depth, and lighting. @Image 2 is a style reference only, not a fixed keyframe; the model extends the world and the subject moves through real space.

[Subjects and Relationships]
The man corresponds to @Image 1 and keeps the same face and clothing throughout. The three pursuers wear matching dark tactical gear with right-thigh holsters, but differ clearly in hair: buzz cut, long black hair, medium brown hair. The alley is barely one body wide, so the pursuers can only come one at a time from the far entrance; the man stands nearer the exit end.

[Event Script]
Stage 1 - First takedown: Opening state: seen over the man's shoulder from the alley's exit end, the wet empty passage runs toward the far entrance. The first pursuer (buzz cut) rushes in; the man pivots off the left wall and drives an elbow across his jaw. End state: the first pursuer lies slumped against the wall.

Stage 2 - Second takedown: The second pursuer (long black hair) steps over the fallen man, both hands empty until now. Seeing the first man fall, he reaches for his right-thigh holster; the man closes the gap before the muzzle comes level, pins the wrist to the wall, and drives a knee up. End state: the pistol lies on the wet ground and the second pursuer is folded at the base of the wall.

Stage 3 - Third takedown: The third pursuer (medium brown hair) hesitates half a step, then lunges. The man ducks the swing, hooks his ankle, and puts him down hard on the wet ground. End state: all three pursuers lie motionless; the man settles into a low ready stance among them, chest rising and falling, and the video ends holding this state.

[Visual and Camera Treatment]
One continuous take. The camera holds the over-the-shoulder position at eye level for the whole take, tracking forward slowly as each body drops, staying on one side of the action line. Rain-slick surfaces; one sodium lamp far overhead throws hard light from above, with cool blue-hour ambience in the gaps between rooftops. Normal speed through Stages 1 and 2; time slams into slow motion as the third pursuer's ankle is hooked, then resolves to normal speed as he lands.

[Audio]
Only rain on metal, scuffing boots, three distinct body impacts, and the man's controlled breathing are heard.

[Maintain Consistency]
Keep the man's identity and clothing, the three pursuers' distinct hairstyles, the alley's width and lighting, and the camera's side of the action line consistent throughout.
```

## What this skill does not do

- It does not edit or extend existing videos — those are separate Seedance workflows with their own rules.
- It does not call any generation API. It writes the prompt; the user submits it.
- It does not choose duration, aspect ratio, or resolution — the user sets those at generation time.
- It does not keep characters consistent across many shots by itself. That is a reference-image discipline — see its companion skill, Character Consistency.
