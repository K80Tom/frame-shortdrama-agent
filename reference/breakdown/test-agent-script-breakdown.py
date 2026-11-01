import json
import os
from pathlib import Path
from typing import Any

from google.adk.tools import FunctionTool, ToolContext
from google.adk.tools.agent_tool import AgentTool
from pydantic import BaseModel, Field
from veadk import Agent
from veadk.skills.utils import load_skill_from_directory
from veadk.tools.skills_tools import SkillsTool, read_file_tool
from veadk.utils.logger import get_logger

from short_drama_agent.execute_skills import execute_skills

logger = get_logger(__name__)


class ScriptCharacter(BaseModel):
    name: str = Field(description="角色姓名或称呼")
    identity: str = Field(description="角色身份定位")
    personality: str = Field(description="性格特征")
    relationship: str = Field(description="与其他角色的主要关系")
    visual_notes: str = Field(description="服装、外形或可视化要点")


class ScriptScene(BaseModel):
    name: str = Field(description="场景名称")
    time_and_place: str = Field(description="时间和地点")
    atmosphere: str = Field(description="场景氛围")
    story_function: str = Field(description="该场景承担的剧情功能")
    asset_notes: str = Field(description="场景资产制作提示")


class ScriptProp(BaseModel):
    name: str = Field(description="道具名称")
    purpose: str = Field(description="道具在剧情中的用途")
    appears_in: str = Field(description="出现的场景或镜头")
    visual_notes: str = Field(description="道具视觉要点")


class StoryboardShot(BaseModel):
    id: str = Field(description="分镜唯一编号，例如 scene_1-1")
    title: str = Field(description="分镜标题，包含集数、场次、镜头号和画面主题")
    description: str = Field(description="可直接用于画面生成的完整视觉描述")
    style: str = Field(description="画面风格，例如 cinematic、anime、realistic")
    camera: str = Field(description="景别或镜头类型，例如 wide、medium、close-up")
    movement: str = Field(description="运镜方式，例如 static、push-in、pan、tilt")
    characters: str = Field(description="出镜角色及造型、状态要点")
    dialogue: str = Field(description="该镜头台词、旁白或声音提示；无台词时为空字符串")
    duration: int = Field(description="镜头建议时长，单位为秒")
    aspectRatio: str = Field(description="画幅比例，例如 16-9、9-16")
    negativePrompt: str = Field(description="画面生成负向提示词")


class ScriptBreakdownResult(BaseModel):
    characters: list[ScriptCharacter] = Field(description="角色拆解")
    scenes: list[ScriptScene] = Field(description="场景拆解")
    props: list[ScriptProp] = Field(description="道具拆解")
    storyboards: list[StoryboardShot] = Field(description="分镜拆解")


SCRIPT_BREAKDOWN_SKILL_NAME = "script-asset-breakdown"
SCRIPT_BREAKDOWN_SKILL_DIR = (
    Path(__file__).resolve().parent.parent / "skills" / SCRIPT_BREAKDOWN_SKILL_NAME
)
SCRIPT_BREAKDOWN_DEFAULT_NEGATIVE_PROMPT = "模糊,低质量,变形,多余手指,文字,水印"


SCRIPT_BREAKDOWN_ROUTING_INSTRUCTION = (
    "\n\n【剧本拆解路由规则】\n"
    "- 当用户要求“剧本相关资产完成图片生成”“检查资产图片生成状态”“补生成资产图片”时，"
    "这不是剧本拆解任务；必须调用 `mcp_router` 查询已有剧本关联资产、检查生成状态，并对未完成资产发起图片生成，"
    "不要调用 `execute_skills` 或 `script_breakdown`，也不要反问用户提供完整剧本。\n"
    "- 当用户给出已有作品名、剧本名或篇章名，并询问角色、场景、道具、剧情或分镜清单（例如“春生照相馆，剧本内的角色、道具有哪些，分镜给我”）时，"
    "这是知识库资料查询与整理任务；必须先查询知识库或使用已注入的知识库资料回答，不要调用 `execute_skills` 或 `script_breakdown`，"
    "也不要反问用户提供完整剧本。\n"
    "- 当用户要求剧本拆解、资产拆解、生成角色、生成场景、生成道具、生成分镜、"
    "从剧本提取制作要素，且没有要求短剧业务入库时：若官方 `execute_skills` 可用，优先直接调用 `execute_skills`，"
    f"并明确指定远端 skill `{SCRIPT_BREAKDOWN_SKILL_NAME}` 执行拆解；"
    "仅当 `execute_skills` 不可用或执行失败时，才回退调用 `script_breakdown` 工具。\n"
    "- 当用户要求“业务分镜入库 / 分镜入库 / ingestStoryboardDecomposition / project_id / project_shot_id”时，"
    "必须直接调用 `mcp_router` 或实际暴露的短剧业务 MCP 工具完成项目、镜头和分镜入库；"
    "当前短剧 MCP 工具通常带有 `Shortdrama Generation API_` 前缀，例如 "
    "`Shortdrama Generation API_listProjects`、`Shortdrama Generation API_createProject`、"
    "`Shortdrama Generation API_lookupProjectShotId`、`Shortdrama Generation API_createProjectShot`、"
    "`Shortdrama Generation API_ingestStoryboardDecomposition`；"
    "不要调用 `execute_skills` 或只调用 `script_breakdown` 后结束。\n"
    "- 拆解类任务不应先查询知识库，除非用户明确要求结合已有作品、角色或资产资料。\n"
    "- 若走 `execute_skills`，应要求 skill 只返回严格 JSON；若走 `script_breakdown`，则按现有结构返回。\n"
    "- 拆解结果返回后，请用中文分区输出：角色、场景、道具、分镜。\n"
    "- 分镜必须按字段 `id/title/description/style/camera/movement/characters/dialogue/"
    "duration/aspectRatio/negativePrompt` 返回，便于用户直接复制给视频或图片生成流程。\n"
    "- 输出末尾补充：如需入库或生成资产文件，可继续说明保存目标或格式。\n"
)


SCRIPT_BREAKDOWN_INSTRUCTION = (
    "你是漫剧/短剧制作前期的剧本拆解 Sub-Agent。"
    "你必须优先调用 `execute_script_breakdown_skill`，通过官方 `execute_skills` 远端 skill `script-asset-breakdown` 执行剧本拆解。"
    "若该工具返回以 `Error:` 开头的失败结果，再调用 `skills_tool` 加载本地 skill `script-asset-breakdown` 作为兜底；"
    "如果 skill 中引用了 `REFERENCE.md` 或 `SCHEMAS.json`，可继续使用 `read_file_tool` 读取。"
    "当 `execute_script_breakdown_skill` 返回结构化 JSON 时，直接按该结果原样输出，不要改写字段或补充结构外内容。"
    "最终返回时，必须严格输出 ScriptBreakdownResult JSON 结构，不添加结构外内容。"
    "角色要能支持立绘和表演设计；场景要能支持美术置景；"
    "道具要能支持资产制作；分镜要能支持画面生成和剪辑。"
    "每条分镜都必须包含 id、title、description、style、camera、movement、"
    "characters、dialogue、duration、aspectRatio、negativePrompt 字段；"
    "description 要写成完整画面提示词，dialogue 无内容时返回空字符串，"
    "duration 使用整数秒，aspectRatio 默认使用 16-9，"
    "negativePrompt 默认包含“模糊,低质量,变形,多余手指,文字,水印”。"
    "若原文信息不足，请基于文本中可推断的内容补足简洁、合理的制作提示，"
    "不要引入与原文冲突的新剧情。"
)


def _build_script_breakdown_skill_workflow_prompt(request: str) -> str:
    return (
        f"请使用 skill `{SCRIPT_BREAKDOWN_SKILL_NAME}` 执行剧本拆解。\n"
        "任务模式：script_breakdown。\n"
        "只返回严格匹配该 skill 中 SCHEMAS.json 的 JSON，不要输出解释、Markdown 或额外文字。\n"
        "若存在台词，必须保留原文；若存在角色、场景、道具，请尽可能完整抽取。\n\n"
        "待拆解内容如下：\n"
        f"{request.strip()}"
    )


def _extract_json_text(raw_text: str) -> str:
    text = (raw_text or "").strip()
    if not text:
        raise ValueError("empty skill output")

    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()

    best_candidate = ""
    best_score = -1
    for candidate in _iter_json_candidates(text):
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        score = _score_script_breakdown_candidate(payload)
        if score > best_score:
            best_candidate = candidate
            best_score = score
        if score >= 10:
            return candidate

    if best_candidate:
        return best_candidate
    raise ValueError("no JSON object found in skill output")


def _iter_json_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    for start, char in enumerate(text):
        if char not in ("{", "["):
            continue
        candidate = _extract_json_candidate_at(text, start)
        if candidate:
            candidates.append(candidate)
    return candidates


def _extract_json_candidate_at(text: str, start: int) -> str | None:
    stack: list[str] = []
    in_string = False
    escape = False
    pairs = {"{": "}", "[": "]"}

    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue

        if char in pairs:
            stack.append(pairs[char])
            continue

        if char in ("}", "]"):
            if not stack or char != stack.pop():
                return None
            if not stack:
                return text[start : index + 1]
    return None


def _score_script_breakdown_candidate(payload: Any) -> int:
    if isinstance(payload, dict):
        score = 0
        if payload.get("mode") == "script_breakdown":
            score += 5
        if isinstance(payload.get("characters"), list):
            score += 2
        if isinstance(payload.get("scenes"), list):
            score += 2
        if isinstance(payload.get("props"), list):
            score += 2
        if isinstance(payload.get("storyboards"), list):
            score += 5
        return score
    if isinstance(payload, list):
        return 1
    return 0


def _detect_style(*values: str) -> str:
    merged = " ".join(value for value in values if value)
    if any(keyword in merged for keyword in ("动漫", "anime", "二次元")):
        return "anime"
    if any(keyword in merged for keyword in ("写实", "realistic", "photoreal")):
        return "realistic"
    return "cinematic"


def _detect_movement(*values: str) -> str:
    merged = " ".join(value for value in values if value)
    if any(keyword in merged for keyword in ("跟拍", "跟随", "追拍", "tracking")):
        return "tracking"
    if any(keyword in merged for keyword in ("推进", "慢推", "推近", "push-in")):
        return "push-in"
    if any(keyword in merged for keyword in ("拉远", "后撤", "pull-out")):
        return "pull-out"
    if any(keyword in merged for keyword in ("摇镜", "横摇", "pan")):
        return "pan"
    if any(keyword in merged for keyword in ("俯冲", "升降", "crane")):
        return "crane"
    return "static"


def _camera_from_shot_type(shot_type: str) -> str:
    return {
        "特写": "close-up",
        "近景": "medium close-up",
        "中景": "medium",
        "全景": "wide",
        "远景": "long shot",
        "大全景": "extreme wide",
    }.get((shot_type or "").strip(), "medium")


def _convert_skill_storyboard_shot(shot: dict[str, Any]) -> dict[str, Any]:
    duration_sec = int(
        round(float(shot.get("duration_sec") or shot.get("duration") or 4))
    )
    shot_index = int(shot.get("shot_no") or 1)
    scene_key = str(shot.get("scene_continuity_key") or "SCENE_01").lower()
    shot_type = str(shot.get("shot_type") or "中景")
    narration = str(shot.get("narration") or shot.get("content") or "")
    video_prompt = str(shot.get("video_prompt") or "")
    dialogue = str(shot.get("dialogue") or "（无台词）")
    characters = shot.get("character_names") or shot.get("characters_in_shot") or []
    scenes = shot.get("scene_names") or shot.get("scenes_in_shot") or []
    if not scenes and shot.get("scene_anchor"):
        scenes = [str(shot.get("scene_anchor"))]

    return {
        "id": f"{scene_key}-{shot_index}",
        "title": f"第{shot_index}镜·{(scenes[0] if scenes else '分镜')}",
        "description": video_prompt or narration,
        "style": _detect_style(video_prompt, narration),
        "camera": _camera_from_shot_type(shot_type),
        "movement": _detect_movement(video_prompt, narration),
        "characters": "、".join(characters),
        "dialogue": "" if dialogue == "（无台词）" else dialogue,
        "duration": max(1, duration_sec),
        "aspectRatio": "16-9",
        "negativePrompt": SCRIPT_BREAKDOWN_DEFAULT_NEGATIVE_PROMPT,
    }


def _convert_skill_result_to_legacy_result(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("mode") not in (None, "script_breakdown"):
        raise ValueError(f"unexpected script breakdown mode: {payload.get('mode')!r}")

    return {
        "characters": payload.get("characters") or [],
        "scenes": payload.get("scenes") or [],
        "props": payload.get("props") or [],
        "storyboards": [
            _convert_skill_storyboard_shot(shot)
            for shot in (payload.get("storyboards") or [])
        ],
    }


async def execute_script_breakdown_skill(
    request: str, tool_context: ToolContext = None
) -> dict[str, Any] | str:
    if not os.getenv("AGENTKIT_TOOL_ID", "").strip():
        return (
            "Error: AGENTKIT_TOOL_ID is not configured, cannot call official "
            "execute_skills for script breakdown."
        )

    try:
        workflow_prompt = _build_script_breakdown_skill_workflow_prompt(request)
        raw_result = await execute_skills(workflow_prompt, tool_context)
        payload = json.loads(_extract_json_text(raw_result))
        return _convert_skill_result_to_legacy_result(payload)
    except Exception as exc:
        logger.warning(f"execute_script_breakdown_skill failed: {exc}")
        return f"Error: execute_script_breakdown_skill failed: {exc}"


def create_script_breakdown_skill_tools() -> list:
    skill = load_skill_from_directory(SCRIPT_BREAKDOWN_SKILL_DIR)
    if skill is None:
        raise RuntimeError(
            f"Failed to load local skill from {SCRIPT_BREAKDOWN_SKILL_DIR}"
        )

    return [
        FunctionTool(execute_script_breakdown_skill),
        SkillsTool({skill.name: skill}),
        FunctionTool(read_file_tool),
    ]


def create_script_breakdown_subagent(**agent_overrides) -> Agent:
    defaults = {
        "name": "script_breakdown",
        "description": "从剧本中拆解角色、场景、道具和分镜。",
        "instruction": SCRIPT_BREAKDOWN_INSTRUCTION,
        "output_schema": ScriptBreakdownResult,
        "tools": create_script_breakdown_skill_tools(),
    }
    defaults.update(agent_overrides)
    return Agent(**defaults)


def create_script_breakdown_tool(**agent_overrides) -> AgentTool:
    return AgentTool(create_script_breakdown_subagent(**agent_overrides))
