---
name: character-consistency
description: Keep one character identical across every generated shot. Expand a short Character Brief into ultra-detailed generation prompts, build a three-panel character sheet (bust-up, full body front, full body rear) from a single close-up, and attach it as an identity reference on every generation. Use when the user wants the same character to stay consistent across multiple shots, scenes, or takes.
---

# Character Consistency

Keep the user's character identical across every generated shot. The method: expand a short Brief into ultra-detailed prompts, turn the prompts into a character sheet, and ride the sheet on every generation the character appears in.

The core job of this skill is **expansion**. Every one-line field in the Brief becomes a paragraph of specifics in the prompt. Vague prompts produce generic faces — and a generic face cannot stay consistent, because there is nothing distinctive for the next generation to hold on to. Detail is what consistency is made of.

## What it does

**Input:** a filled Character Brief (below). A freeform description is fine too — map it into the Brief and show the result back to the user before writing any prompt.

**Output:** an ultra-detailed close-up prompt and a three-panel sheet prompt (bust-up / full body front / full body rear) for the user to run, plus the role line the user will carry into every later prompt where the character appears. This skill writes prompts only — the user runs the generations and picks the candidates.

## Step 0. Fill the Character Brief

```text
NAME:        (name or handle)
AGE / BUILD: (age impression, gender, build and height impression)
FACE:        (eyes, skin, identifying features — be specific)
HAIR:        (color, length, texture, how it parts and falls)
OUTFIT:      (top, bottom, shoes, accessories — item by item: garment, material,
             color, wear. The full-body panels are built from this text;
             anything not written here does not exist.)
CLOSE-UP:    (attach an existing close-up image if you have one;
             if not, the skill writes the close-up prompt from this Brief)
NOTES:       (optional: overall vibe, visual style — photoreal, anime, etc.)
```

Blank fields are allowed: fill them with conservative proposals and show the user the completed Brief. Ask a question only when two readings would produce different people — decide everything else and move on.

## Step 1. Lock the close-up

If the Brief came with a close-up image, skip the close-up generation — but still write out the identity blocks below from the Brief and the image; Step 2 needs them.

Otherwise, expand the Brief into an ultra-detailed close-up prompt with this structure and hand it to the user:

```text
Ultra-detailed portrait of <NAME>: <one-line summary from the Brief>.
Chest-up framing, front view, facing camera, plain cool grey background,
even soft studio light.

EYES (highest priority):
<iris color and texture, pupil, catchlights, eyelids, brow shape — expanded
from FACE. The eyes are where identity lives; spend the most words here.>

SKIN:
<tone, texture, lines, scars, stubble, marks — the details that make this
face this face and no other.>

HAIR:
<color, length, texture, how it parts and falls — expanded from HAIR.>

EXPRESSION:
<the character's default expression, precisely: what the mouth, brows, and
gaze do at rest.>

CLOTHING (visible in frame):
<the collar and shoulders of the OUTFIT as they appear chest-up.>

TECHNICAL:
<visual style from NOTES — photorealistic, anime, etc.> Sharp focus on the
eyes. High resolution.
```

Have the user generate several candidates with this prompt and pick one. The picked image is now the character — every later asset derives from it — so advise the user not to settle for a face that is merely acceptable: it should be one they would recognize in a crowd.

## Step 2. Generate the three-panel sheet

Write the sheet prompt below and have the user run it with the close-up attached as the reference image — the output is **one 16:9 sheet with three panels: bust-up front, full body front, full body rear.** The IDENTITY block re-states everything — the close-up shows nothing below the chest, so the full-body panels are built entirely from the OUTFIT text.

```text
Character reference sheet of the same person, 16:9 landscape format,
three panels side by side on a single seamless cool grey studio background,
identical grey tone across all three panels.
Left panel (about 45% of frame width): bust-up portrait framed from the chest up,
front view, facing camera, head height about one third of the panel height.
Center panel: full body standing straight, front view, arms relaxed at sides,
feet visible, figure filling about 90% of the panel height.
Right panel: full body standing straight, rear view, seen from directly behind,
heels visible, figure filling about 90% of the panel height.
Even studio lighting, consistent appearance, hairstyle and outfit across all three panels.

IDENTITY:
<the EYES / SKIN / HAIR blocks from Step 1, then the complete OUTFIT item by
item: garment, material, color, wear.>
```

Practical notes, each paid for in retakes:

- **Cool grey beats white.** A white background clips highlights and destabilizes identity; a seamless cool grey keeps all three panels on the same footing.
- **Keep the sheet plain.** Do not bake your film's color grade or style into it — a neutral studio sheet composites into any scene; a stylized one fights every scene it enters.
- **Panel ratios are probabilistic.** Some runs squeeze the panels or drift toward equal thirds. Have the user generate a few candidates and pick the cleanest — do not fight a bad layout with prompt edits.
- **Removing gear the close-up shows** (headphones, goggles, gloves): write the state that should exist, never a negation — `bare head with natural hair only`, `bare empty hands`.
- **A new outfit means a new sheet.** Advise the user to make a second sheet for a wardrobe change rather than describing the change ad hoc.

When delivering the sheet prompt, also hand the user the role line they will need afterward — it goes into every later prompt where the character appears:

```text
@Image 1 defines <NAME>'s facial features, hairstyle, and clothing.
Do not use the grey background or the panel layout.
```

How that reference is then written into a full video prompt — verbal reinforcement, several characters sharing a frame — is the companion skill, Video Prompt Director.

## Self-check

- The Brief is complete — especially OUTFIT, item by item — before any prompt is written.
- Every Brief field was expanded into specifics; no field survived as a vague one-liner.
- All three panels read as the same person in the same outfit; the sheet is plain grey with no scene style baked in.
- The role line was delivered together with the sheet prompt.

## What this skill does not do

- It does not write the full video prompt — that is Video Prompt Director. This skill supplies the identity assets that prompt rides on.
- It does not call any generation API. It writes the prompts; the user runs them.
- It does not make generation deterministic. Sheets and shots are still probabilistic; the method turns "hope the face holds" into "pick the take where everything else is right, because the face already holds."
