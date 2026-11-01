"""Small, serialisable contracts for the minimum production chain."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal


def to_dict(value: object) -> object:
    """Convert nested dataclasses to JSON-safe built-in values."""

    if hasattr(value, "__dataclass_fields__"):
        return {key: to_dict(item) for key, item in asdict(value).items()}
    if isinstance(value, list):
        return [to_dict(item) for item in value]
    if isinstance(value, dict):
        return {key: to_dict(item) for key, item in value.items()}
    return value


@dataclass(frozen=True)
class Evidence:
    scene_no: int
    excerpt: str
    confidence: float
    risk_flags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetRequirementCandidate:
    requirement_id: str
    kind: Literal["character", "scene", "prop"]
    name: str
    evidence: Evidence
    state: Literal["candidate"] = "candidate"


@dataclass(frozen=True)
class SceneDraft:
    scene_id: str
    scene_no: int
    title: str
    dialogue: str
    revision: int = 1


@dataclass(frozen=True)
class ScriptBreakdown:
    project_id: str
    script_title: str
    episode_no: int
    script_version: str
    parse_batch_id: str
    scenes: list[SceneDraft]
    requirements: list[AssetRequirementCandidate]


@dataclass(frozen=True)
class AssetRecord:
    asset_id: str
    name: str
    kind: str
    approved: bool = True
    description: str = ""
    aliases: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetMatch:
    requirement_id: str
    asset_id: str
    confidence: float
    rationale: str


@dataclass(frozen=True)
class AssetGap:
    requirement_id: str
    recommendation: Literal["generate", "upload", "manual_assignment"]


@dataclass(frozen=True)
class ReviewItem:
    review_id: str
    target_type: Literal["shot_card", "generation_result"]
    target_id: str
    reason: str


@dataclass(frozen=True)
class ShotCardDraft:
    shot_id: str
    scene_id: str
    revision: int
    prompt_summary: str
    asset_ids: list[str]
    state: Literal["draft"] = "draft"


@dataclass(frozen=True)
class ScenePackage:
    scene_id: str
    readiness: Literal["blocked", "ready_for_review", "ready_for_generate"]
    shot: ShotCardDraft
    missing_requirement_ids: list[str]


@dataclass(frozen=True)
class GenerationTask:
    task_id: str
    shot_id: str
    trace_id: str
    idempotency_key: str
    state: Literal["queued", "running", "succeeded", "failed"]


@dataclass(frozen=True)
class GenerationResult:
    result_id: str
    task_id: str
    shot_id: str
    state: Literal["candidate"]
    cost_cents: int
    output_url: str = ""
