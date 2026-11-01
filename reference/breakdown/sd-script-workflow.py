"""Workflow orchestration with real LLM-powered skills and review gates.

Each Skill delegates semantic understanding to an injected LLMClient
(Volcengine Ark API).  Skills remain pure-function-style: they read
upstream dataclass contracts, call the LLM, and return downstream
dataclass contracts.  No skill may bypass ReviewGate or write to an
external asset library.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Iterable

from .llm import LLMClient, default_llm
from .models import (
    AssetGap, AssetMatch, AssetRecord, AssetRequirementCandidate, Evidence,
    GenerationResult, GenerationTask, ReviewItem, SceneDraft, ScenePackage,
    ScriptBreakdown, ShotCardDraft,
)


def stable_id(prefix: str, *parts: object) -> str:
    """Create deterministic IDs so reruns remain traceable and idempotent."""

    # 同一业务输入始终生成相同 ID，重跑时可关联回执并避免重复提交。
    joined = "|".join(str(part) for part in parts)
    return f"{prefix}_{sha256(joined.encode()).hexdigest()[:12]}"


# ---------------------------------------------------------------------------
# ScriptSkill — LLM 语义剧本拆解
# ---------------------------------------------------------------------------

_SCRIPT_SYSTEM_PROMPT = (
    "你是短剧制作前期的剧本拆解专家。"
    "给定剧本文本，请精确提取所有角色（character）、场景（scene）、道具（prop），"
    "并为每项提供证据：出自第几场、原文摘录、置信度（0-1）。"
    "同时按场次拆分场景草稿，完整保留原文对白，不要改写或概括台词。"
    "只输出严格的 JSON，不要添加解释、Markdown 或额外文字。"
)

_SCRIPT_USER_TEMPLATE = (
    "项目ID: {project_id}\n"
    "标题: {title}\n"
    "集数: {episode_no}\n\n"
    "剧本原文:\n{script_text}\n\n"
    "请输出以下 JSON 结构：\n"
    "{{\n"
    '  "scenes": [{{"scene_no": 1, "title": "场景标题", "dialogue": "对白原文"}}],\n'
    '  "requirements": [\n'
    '    {{"kind": "character", "name": "角色名", "evidence": {{"scene_no": 1, "excerpt": "原文摘录", "confidence": 0.9}}}},\n'
    '    {{"kind": "scene", "name": "场景名", "evidence": {{"scene_no": 1, "excerpt": "原文摘录", "confidence": 0.9}}}},\n'
    '    {{"kind": "prop", "name": "道具名", "evidence": {{"scene_no": 1, "excerpt": "原文摘录", "confidence": 0.9}}}}\n'
    "  ]\n"
    "}}"
)


def _validate_script(result: dict) -> str | None:
    """校验 ScriptSkill 的 LLM 返回结构。"""
    if "scenes" not in result:
        return "缺少 'scenes' 字段，应包含场景数组"
    if not isinstance(result["scenes"], list):
        return "'scenes' 应为数组"
    if "requirements" not in result:
        return "缺少 'requirements' 字段，应包含需求数组"
    if not isinstance(result["requirements"], list):
        return "'requirements' 应为数组"
    for i, s in enumerate(result["scenes"]):
        if "dialogue" not in s:
            return f"scenes[{i}] 缺少 'dialogue' 字段"
    valid_kinds = {"character", "scene", "prop"}
    for i, r in enumerate(result["requirements"]):
        kind = r.get("kind", "")
        if kind not in valid_kinds:
            return f"requirements[{i}].kind '{kind}' 不合法，应为 character/scene/prop"
        if not r.get("name"):
            return f"requirements[{i}] 缺少 'name' 或为空"
    return None


class ScriptSkill:
    """Parse scripts semantically using LLM; cannot inspect or write the asset library."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm or default_llm()

    def run(
        self, *, project_id: str, title: str, episode_no: int, script_text: str,
    ) -> ScriptBreakdown:
        result = self._llm.chat_json(
            system_prompt=_SCRIPT_SYSTEM_PROMPT,
            user_prompt=_SCRIPT_USER_TEMPLATE.format(
                project_id=project_id, title=title,
                episode_no=episode_no, script_text=script_text,
            ),
            validate=_validate_script,
        )

        scenes: list[SceneDraft] = []
        for s in result.get("scenes", []):
            scene_no = int(s.get("scene_no", 1))
            scenes.append(SceneDraft(
                scene_id=stable_id(
                    "scene", project_id, episode_no, scene_no, s.get("dialogue", ""),
                ),
                scene_no=scene_no,
                title=s.get("title", f"第{scene_no}场"),
                dialogue=s.get("dialogue", ""),
            ))

        # LLM 未拆出场次时，将整段文本作为唯一场景。
        if not scenes:
            scenes.append(SceneDraft(
                scene_id=stable_id("scene", project_id, episode_no, script_text),
                scene_no=1, title="首场", dialogue=script_text,
            ))

        requirements: list[AssetRequirementCandidate] = []
        for req in result.get("requirements", []):
            kind = req.get("kind", "")
            if kind not in ("character", "scene", "prop"):
                continue
            name = (req.get("name") or "").strip()
            if not name:
                continue
            ev = req.get("evidence") or {}
            evidence = Evidence(
                scene_no=int(ev.get("scene_no", 1)),
                excerpt=ev.get("excerpt", ""),
                confidence=float(ev.get("confidence", 0.5)),
            )
            requirements.append(AssetRequirementCandidate(
                requirement_id=stable_id("req", kind, name, project_id, episode_no),
                kind=kind, name=name, evidence=evidence,
            ))

        return ScriptBreakdown(
            project_id=project_id, script_title=title, episode_no=episode_no,
            script_version=stable_id("scriptv", script_text),
            parse_batch_id=stable_id("batch", project_id, script_text),
            scenes=scenes, requirements=requirements,
        )


# ---------------------------------------------------------------------------
# AssetSkill — LLM 语义资产匹配
# ---------------------------------------------------------------------------

_ASSET_SYSTEM_PROMPT = (
    "你是短剧资产管理专家。给定需求列表和资产库存，请进行语义匹配。"
    "匹配时综合考虑：名称相似度、别名、类型一致性、描述语义相关性。"
    "为每个需求找到最佳匹配资产，或标记为缺口并推荐操作（generate / upload / manual_assignment）。"
    "只输出严格的 JSON，不要添加解释、Markdown 或额外文字。"
)

_ASSET_USER_TEMPLATE = (
    "需求列表:\n{requirements}\n\n"
    "资产库存:\n{inventory}\n\n"
    "请输出以下 JSON 结构：\n"
    "{{\n"
    '  "matches": [{{"requirement_id": "需求ID", "asset_id": "资产ID", "confidence": 0.95, "rationale": "匹配理由"}}],\n'
    '  "gaps": [{{"requirement_id": "需求ID", "recommendation": "generate"}}]\n'
    "}}"
)


def _validate_asset(result: dict) -> str | None:
    """校验 AssetSkill 的 LLM 返回结构。"""
    if "matches" not in result:
        return "缺少 'matches' 字段，应包含匹配数组（可为空数组）"
    if not isinstance(result["matches"], list):
        return "'matches' 应为数组"
    if "gaps" not in result:
        return "缺少 'gaps' 字段，应包含缺口数组（可为空数组）"
    if not isinstance(result["gaps"], list):
        return "'gaps' 应为数组"
    for i, m in enumerate(result["matches"]):
        if not m.get("requirement_id"):
            return f"matches[{i}] 缺少 'requirement_id'"
        if not m.get("asset_id"):
            return f"matches[{i}] 缺少 'asset_id'"
    valid_recs = {"generate", "upload", "manual_assignment"}
    for i, g in enumerate(result["gaps"]):
        if not g.get("requirement_id"):
            return f"gaps[{i}] 缺少 'requirement_id'"
        rec = g.get("recommendation", "")
        if rec and rec not in valid_recs:
            return f"gaps[{i}].recommendation '{rec}' 不合法，应为 generate/upload/manual_assignment"
    return None


class AssetSkill:
    """Reconcile candidates with approved inventory using LLM; does not create final assets."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm or default_llm()

    def run(
        self,
        requirements: Iterable[AssetRequirementCandidate],
        inventory: Iterable[AssetRecord],
    ) -> tuple[list[AssetMatch], list[AssetGap]]:
        req_list = list(requirements)
        inv_list = list(inventory)

        if not req_list:
            return [], []

        # 无库存时所有需求都是缺口。
        if not inv_list:
            return [], [AssetGap(r.requirement_id, "generate") for r in req_list]

        req_data = [
            {"requirement_id": r.requirement_id, "kind": r.kind, "name": r.name}
            for r in req_list
        ]
        inv_data = [
            {
                "asset_id": a.asset_id,
                "kind": a.kind,
                "name": a.name,
                "description": a.description,
                "aliases": a.aliases,
            }
            for a in inv_list
        ]

        result = self._llm.chat_json(
            system_prompt=_ASSET_SYSTEM_PROMPT,
            user_prompt=_ASSET_USER_TEMPLATE.format(
                requirements=json.dumps(req_data, ensure_ascii=False, indent=2),
                inventory=json.dumps(inv_data, ensure_ascii=False, indent=2),
            ),
            validate=_validate_asset,
        )

        valid_req_ids = {r.requirement_id for r in req_list}
        valid_asset_ids = {a.asset_id for a in inv_list}

        matches: list[AssetMatch] = []
        matched_req_ids: set[str] = set()
        for m in result.get("matches", []):
            req_id = m.get("requirement_id", "")
            asset_id = m.get("asset_id", "")
            # 只接受合法 ID，防止 LLM 幻觉。
            if req_id in valid_req_ids and asset_id in valid_asset_ids:
                matches.append(AssetMatch(
                    requirement_id=req_id,
                    asset_id=asset_id,
                    confidence=float(m.get("confidence", 0.5)),
                    rationale=m.get("rationale", ""),
                ))
                matched_req_ids.add(req_id)

        gaps: list[AssetGap] = []
        gap_req_ids: set[str] = set()
        for g in result.get("gaps", []):
            req_id = g.get("requirement_id", "")
            if req_id in valid_req_ids and req_id not in matched_req_ids:
                rec = g.get("recommendation", "generate")
                if rec not in ("generate", "upload", "manual_assignment"):
                    rec = "generate"
                gaps.append(AssetGap(req_id, rec))
                gap_req_ids.add(req_id)

        # 补全 LLM 可能遗漏的未匹配需求。
        for req in req_list:
            if (req.requirement_id not in matched_req_ids
                    and req.requirement_id not in gap_req_ids):
                gaps.append(AssetGap(req.requirement_id, "generate"))

        return matches, gaps


# ---------------------------------------------------------------------------
# SceneSkill — LLM 生成专业镜头卡提示词
# ---------------------------------------------------------------------------

_SCENE_SYSTEM_PROMPT = (
    "你是短剧分镜师。给定场景草稿和已匹配资产，请为每个场景生成专业的镜头卡画面提示词。"
    "提示词应包含：画面主体描述、镜头景别（特写/近景/中景/全景/远景）、"
    "运镜方式（固定/推进/拉远/横摇/跟拍）、光影氛围（光线方向、色温、明暗对比）、"
    "角色状态与动作、关键道具或场景元素。"
    "提示词应可直接用于 AI 画面生成。只输出严格的 JSON，不要添加解释、Markdown 或额外文字。"
)

_SCENE_USER_TEMPLATE = (
    "场景草稿:\n{scenes}\n\n"
    "已匹配资产:\n{matches}\n\n"
    "缺口:\n{gaps}\n\n"
    "请为每个场景生成镜头卡提示词，输出以下 JSON 结构：\n"
    '{{"shots": [{{"scene_id": "场景ID", "prompt_summary": "完整画面提示词"}}]}}'
)


def _validate_scene(result: dict) -> str | None:
    """校验 SceneSkill 的 LLM 返回结构。"""
    if "shots" not in result:
        return "缺少 'shots' 字段，应包含镜头卡数组"
    if not isinstance(result["shots"], list):
        return "'shots' 应为数组"
    for i, s in enumerate(result["shots"]):
        if not s.get("scene_id"):
            return f"shots[{i}] 缺少 'scene_id'"
        if not s.get("prompt_summary"):
            return f"shots[{i}] 缺少 'prompt_summary' 或为空"
    return None


class SceneSkill:
    """Assemble reviewable shot-card drafts with LLM-generated prompts."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm or default_llm()

    def run(
        self,
        breakdown: ScriptBreakdown,
        matches: list[AssetMatch],
        gaps: list[AssetGap],
    ) -> list[ScenePackage]:
        scene_data = [
            {
                "scene_id": s.scene_id,
                "scene_no": s.scene_no,
                "title": s.title,
                "dialogue": s.dialogue,
            }
            for s in breakdown.scenes
        ]
        match_data = [
            {
                "requirement_id": m.requirement_id,
                "asset_id": m.asset_id,
                "confidence": m.confidence,
            }
            for m in matches
        ]
        gap_data = [
            {
                "requirement_id": g.requirement_id,
                "recommendation": g.recommendation,
            }
            for g in gaps
        ]

        result = self._llm.chat_json(
            system_prompt=_SCENE_SYSTEM_PROMPT,
            user_prompt=_SCENE_USER_TEMPLATE.format(
                scenes=json.dumps(scene_data, ensure_ascii=False, indent=2),
                matches=json.dumps(match_data, ensure_ascii=False, indent=2),
                gaps=json.dumps(gap_data, ensure_ascii=False, indent=2),
            ),
            validate=_validate_scene,
        )

        # 构建 scene_id → prompt_summary 映射。
        prompt_map: dict[str, str] = {}
        for shot in result.get("shots", []):
            sid = shot.get("scene_id", "")
            if sid:
                prompt_map[sid] = shot.get("prompt_summary", "")

        asset_ids = [m.asset_id for m in matches]
        gap_ids = [g.requirement_id for g in gaps]

        packages: list[ScenePackage] = []
        for scene in breakdown.scenes:
            # LLM 未返回提示词时回退为场景标题+对白。
            prompt = prompt_map.get(scene.scene_id, f"{scene.title}：{scene.dialogue}")
            shot = ShotCardDraft(
                shot_id=stable_id("shot", scene.scene_id, scene.revision),
                scene_id=scene.scene_id,
                revision=scene.revision,
                prompt_summary=prompt,
                asset_ids=list(asset_ids),
            )
            packages.append(ScenePackage(
                scene_id=scene.scene_id,
                readiness="blocked" if gap_ids else "ready_for_review",
                shot=shot,
                missing_requirement_ids=list(gap_ids),
            ))

        return packages


# ---------------------------------------------------------------------------
# ReviewGate — 独占审批状态，任何 Skill 不可越权
# ---------------------------------------------------------------------------

class ReviewGate:
    """Own irreversible approval transitions; no skill may bypass this boundary."""

    def __init__(self) -> None:
        self._approved: set[str] = set()

    def request(self, target_type: str, target_id: str, reason: str) -> ReviewItem:
        return ReviewItem(
            stable_id("review", target_type, target_id),
            target_type, target_id, reason,
        )

    def approve(self, item: ReviewItem, reviewer: str) -> None:
        # reviewer 不能为空，避免自动流程伪造"已人审"的状态。
        if not reviewer:
            raise ValueError("reviewer is required for an approval")
        self._approved.add(item.target_id)

    def require_approved(self, target_id: str) -> None:
        if target_id not in self._approved:
            raise PermissionError(f"{target_id} has not passed ReviewGate")


# ---------------------------------------------------------------------------
# GenerationSkill — 调用真实画面生成 API
# ---------------------------------------------------------------------------

class GenerationSkill:
    """Create real generation tasks only for director-approved shot cards."""

    def __init__(
        self, review_gate: ReviewGate, llm: LLMClient | None = None,
    ) -> None:
        self._review_gate = review_gate
        self._llm = llm or default_llm()
        self._tasks: dict[str, GenerationTask] = {}
        self._results: dict[str, GenerationResult] = {}

    def run(
        self,
        shot: ShotCardDraft,
        trace_id: str,
        idempotency_key: str,
    ) -> tuple[GenerationTask, GenerationResult]:
        # 生成前强制检查镜头卡审片，禁止 Scene 或 Generation 自行越权。
        self._review_gate.require_approved(shot.shot_id)

        task = self._tasks.get(idempotency_key)
        if task is None:
            # 以幂等键去重：网络重试不能创建第二个生成任务。
            task = GenerationTask(
                stable_id("gen", shot.shot_id, idempotency_key),
                shot.shot_id, trace_id, idempotency_key, "running",
            )
            self._tasks[idempotency_key] = task

            try:
                output_url = self._llm.generate_image(
                    prompt=shot.prompt_summary,
                    size="1024x1024",
                )
                task = GenerationTask(
                    task.task_id, task.shot_id, task.trace_id,
                    task.idempotency_key, "succeeded",
                )
                self._tasks[idempotency_key] = task
                result = GenerationResult(
                    stable_id("result", task.task_id),
                    task.task_id, shot.shot_id, "candidate",
                    cost_cents=20,
                    output_url=output_url,
                )
            except Exception:
                task = GenerationTask(
                    task.task_id, task.shot_id, task.trace_id,
                    task.idempotency_key, "failed",
                )
                self._tasks[idempotency_key] = task
                result = GenerationResult(
                    stable_id("result", task.task_id),
                    task.task_id, shot.shot_id, "candidate",
                    cost_cents=0,
                    output_url="",
                )

            self._results[idempotency_key] = result
        else:
            result = self._results.get(idempotency_key, GenerationResult(
                stable_id("result", task.task_id),
                task.task_id, shot.shot_id, "candidate",
                cost_cents=0,
                output_url="",
            ))

        return task, result


# ---------------------------------------------------------------------------
# ProductionChainAgent — 薄协调层
# ---------------------------------------------------------------------------

@dataclass
class ProductionChainAgent:
    """Thin coordinator: routes work but delegates state decisions to domain services."""

    review_gate: ReviewGate
    script: ScriptSkill
    asset: AssetSkill
    scene: SceneSkill
    generation: GenerationSkill

    @classmethod
    def create(cls, llm: LLMClient | None = None) -> "ProductionChainAgent":
        gate = ReviewGate()
        return cls(
            gate,
            ScriptSkill(llm=llm),
            AssetSkill(llm=llm),
            SceneSkill(llm=llm),
            GenerationSkill(gate, llm=llm),
        )

    def promote_result_to_asset(
        self, result: GenerationResult, review: ReviewItem,
    ) -> AssetRecord:
        """Allow asset creation only after a separate result-review approval."""

        # 生成结果与正式资产分离；只有结果二次审片后才允许显式入库。
        if review.target_id != result.result_id:
            raise ValueError("review item does not belong to this generation result")
        self.review_gate.require_approved(result.result_id)
        return AssetRecord(
            stable_id("asset", result.result_id),
            f"generated-{result.shot_id}", "video",
        )
