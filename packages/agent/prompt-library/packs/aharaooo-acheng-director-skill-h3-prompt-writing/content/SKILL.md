---
name: h3-prompt-writing
description: |
  MiniMax H3 视频生成提示词撰写与优化专家 (T2VA, I2VA, FL2VA, L2VA, Ref2VA)。
  Write and optimize structured MiniMax H3 video generation prompts for all five generation modes: T2VA (文生视频+音效), I2VA (首帧图生视频), FL2VA (首尾帧生成), L2VA (尾帧逆推), and Ref2VA (全参考模式).
  Composes integrated_multimodal_description, overall_soundscape, non_diegetic_music, shot breakdowns, and reference anchors.
  Trigger when user mentions 'minimax h3', 'h3 prompt', 'h3 提示词', 'h3-prompt-writing', '视频提示词', or asks to write/rewrite prompts for MiniMax H3.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required.
metadata:
  trigger-words: [minimax h3, h3 prompt, h3 提示词, h3提示词, minimax 视频提示词, t2va, i2va, fl2va, l2va, ref2va, minimax-h3, h3-prompt-writing]
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
## Tips for Better Results
- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
