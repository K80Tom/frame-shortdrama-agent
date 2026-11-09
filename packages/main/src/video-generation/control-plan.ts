import {
  canonicalDigest,
  type ControlFrameVersion,
  type DirectorControlArtifact,
  type ProviderCapabilityDecision,
  type ProviderCapabilityRevision,
  type VideoGenerationPlan,
  type VideoGenerationSpec,
  type VideoIssue,
} from '@lyra/shared';

export interface VideoControlCompileInput {
  spec: Readonly<VideoGenerationSpec>;
  capability: Readonly<ProviderCapabilityRevision>;
  controlFrames: ReadonlyArray<Readonly<ControlFrameVersion>>;
  directorArtifacts: ReadonlyArray<Readonly<DirectorControlArtifact>>;
}

export interface VideoControlCompileResult {
  plan: VideoGenerationPlan;
  issues: VideoIssue[];
}

const FRAME_KINDS = new Set(['first_frame', 'last_frame']);

function issue(spec: VideoGenerationSpec, code: string, message: string, requirement: VideoIssue['category'],
  blocking: boolean): VideoIssue {
  return {
    schemaVersion: 'lyra-video-repair/1',
    id: `vissue_${canonicalDigest({ spec: spec.contentDigest, code, message }).slice(0, 32)}`,
    workspaceId: spec.workspaceId, projectId: spec.projectId, shotId: spec.shotId, neighborShotId: null,
    category: requirement, code, severity: blocking ? 'error' : 'warning', blocking,
    timeRange: null, frameRefs: [], evidenceRefs: [], expected: '控制输入满足供应商真实能力',
    actual: message, suggestedRepairScope: { shotIds: [spec.shotId], actions: blocking ? ['regenerate_control_frame'] : ['reevaluate'],
      regenerateControlFrame: blocking, regenerateCandidateIndexes: [], reassignNeighborCandidate: false, manualOnly: !blocking },
  };
}

function frameFor(input: VideoControlCompileInput, id: string): ControlFrameVersion | null {
  return input.controlFrames.find(frame => frame.id === id) ?? null;
}

function validateFrame(frame: ControlFrameVersion, input: VideoControlCompileInput, kind: 'first' | 'last'):
  { ok: true } | { ok: false; code: string; message: string } {
  const spec = input.spec;
  if (frame.workspaceId !== spec.workspaceId || frame.projectId !== spec.projectId || frame.shotId !== spec.shotId) {
    return { ok: false, code: 'CONTROL_FRAME_SCOPE_MISMATCH', message: '控制帧不属于当前工作区、项目或镜头。' };
  }
  if (frame.kind !== kind) return { ok: false, code: 'CONTROL_FRAME_KIND_MISMATCH', message: '控制帧类型与请求角色不一致。' };
  if (frame.sourceShotSpecVersionId !== spec.shotSpecRevisionId || frame.sourceShotSpecDigest !== spec.shotSpecDigest) {
    return { ok: false, code: 'CONTROL_FRAME_SHOT_SPEC_MISMATCH', message: '控制帧不是由当前冻结 ShotSpec 派生。' };
  }
  if (frame.review.status !== 'pass' || !frame.adoptedAt) {
    return { ok: false, code: 'CONTROL_FRAME_NOT_ADOPTED', message: '控制帧尚未通过审核并采用。' };
  }
  if (frame.width < 1 || frame.height < 1) return { ok: false, code: 'CONTROL_FRAME_SIZE_INVALID', message: '控制帧尺寸无效。' };
  if (frame.ratio !== spec.params.ratio) {
    const requirement = spec.controls.find(item => item.kind === (kind === 'first' ? 'first_frame' : 'last_frame'));
    if (requirement?.ratioTransform === 'blocked' || !requirement) {
      return { ok: false, code: 'CONTROL_FRAME_RATIO_INCOMPATIBLE', message: '控制帧画幅与目标视频画幅不兼容。' };
    }
  }
  return { ok: true };
}

function decided(requirement: ProviderCapabilityDecision['requirement'], decision: ProviderCapabilityDecision['decision'],
  actualField: string | null, reason: string): ProviderCapabilityDecision {
  return { requirement, decision, actualField, reason, evidenceRefs: [] };
}

/**
 * Pure compiler: it never opens a URL, reads an object or submits a provider
 * request. The Worker later resolves the stable objectVersionIds to short-lived
 * URLs. A requirement that cannot be truly applied is never reported as applied.
 */
export function compileVideoGeneration(input: VideoControlCompileInput): VideoControlCompileResult {
  const { spec, capability } = input;
  if (capability.workspaceId !== spec.workspaceId || capability.id !== spec.providerCapabilityRevisionId) {
    throw new Error('Provider capability revision does not belong to this workspace or spec.');
  }
  const decisions: ProviderCapabilityDecision[] = [];
  const blockers: VideoGenerationPlan['blockers'] = [];
  const actualControls: VideoGenerationPlan['actualControls'] = [];
  const controlIssues: VideoIssue[] = [];
  const firstFrameObjectVersionId = { value: null as string | null };
  const lastFrameObjectVersionId = { value: null as string | null };
  const referenceObjectVersionIds: string[] = [];

  if (spec.params.durationSeconds < capability.limits.durationSeconds.min
    || spec.params.durationSeconds > capability.limits.durationSeconds.max) {
    blockers.push({ code: 'VIDEO_DURATION_UNSUPPORTED', message: '时长不在供应商能力范围。', requirement: 'first_frame' });
  }
  if (!capability.limits.ratios.includes(spec.params.ratio)) {
    blockers.push({ code: 'VIDEO_RATIO_UNSUPPORTED', message: '画幅不在供应商能力范围。', requirement: 'first_frame' });
  }
  if (!capability.limits.resolutions.includes(spec.params.resolution)) {
    blockers.push({ code: 'VIDEO_RESOLUTION_UNSUPPORTED', message: '分辨率不在供应商能力范围。', requirement: 'first_frame' });
  }
  if (spec.params.seed !== null && !capability.seed) {
    blockers.push({ code: 'VIDEO_SEED_UNSUPPORTED', message: '供应商不支持固定 seed。', requirement: 'first_frame' });
  }
  if (spec.negativePrompt && !capability.negativePrompt) {
    // Prompt-only description is not a provider-level negative prompt. Leave the
    // decision list free of a false "applied" claim; the prompt itself is recorded
    // separately and never rendered as a native capability.
  }

  for (const requirement of spec.controls) {
    const frameKind = requirement.kind === 'first_frame' ? 'first' : requirement.kind === 'last_frame' ? 'last' : null;
    if (frameKind) {
      if (!capability.imageToVideo || (frameKind === 'first' && !capability.controls.firstFrame)
        || (frameKind === 'last' && !capability.controls.lastFrame)) {
        const code = frameKind === 'first' ? 'VIDEO_FIRST_FRAME_UNSUPPORTED' : 'VIDEO_LAST_FRAME_UNSUPPORTED';
        if (requirement.required) {
          blockers.push({ code, message: `供应商不支持${frameKind === 'first' ? '首帧' : '尾帧'}输入。`, requirement: requirement.kind });
          decisions.push(decided(requirement.kind, 'blocked', null, '硬性控制要求无法满足，未提交付费请求。'));
        } else {
          decisions.push(decided(requirement.kind, 'unsupported', null, '供应商不支持，按可选控制降级。'));
        }
        continue;
      }
      if (!requirement.artifact) {
        if (requirement.required) blockers.push({ code: 'CONTROL_FRAME_MISSING', message: '缺少已采用的控制帧。', requirement: requirement.kind });
        decisions.push(decided(requirement.kind, requirement.required ? 'blocked' : 'unsupported', null, '没有已采用的控制帧引用。'));
        continue;
      }
      const frame = frameFor(input, requirement.artifact.id);
      if (!frame) {
        blockers.push({ code: 'CONTROL_FRAME_NOT_FOUND', message: '控制帧不存在或未冻结。', requirement: requirement.kind });
        decisions.push(decided(requirement.kind, 'blocked', null, '控制帧无法从冻结版本图中解析。'));
        continue;
      }
      const checked = validateFrame(frame, input, frameKind);
      if (!checked.ok) {
        if (requirement.required) blockers.push({ code: checked.code, message: checked.message, requirement: requirement.kind });
        decisions.push(decided(requirement.kind, requirement.required ? 'blocked' : 'unsupported', null, checked.message));
        controlIssues.push(issue(spec, checked.code, checked.message, 'upstream_input', requirement.required));
        continue;
      }
      const transformed = frame.ratio !== spec.params.ratio;
      decisions.push(decided(requirement.kind, transformed ? 'transformed' : 'applied',
        `content[].role=${frameKind === 'first' ? 'first_frame' : 'last_frame'}`,
        transformed ? `按 ${requirement.ratioTransform} 显式转换画幅后发送。` : '真实发送已采用控制帧。'));
      if (frameKind === 'first') firstFrameObjectVersionId.value = frame.objectVersionId;
      else lastFrameObjectVersionId.value = frame.objectVersionId;
      actualControls.push(requirement.kind);
      continue;
    }

    if (requirement.kind === 'reference_image') {
      if (!capability.imageToVideo || capability.controls.referenceImages.max < 1) {
        const code = 'VIDEO_REFERENCE_IMAGES_UNSUPPORTED';
        if (requirement.required) blockers.push({ code, message: '供应商不支持参考图片。', requirement: requirement.kind });
        decisions.push(decided(requirement.kind, requirement.required ? 'blocked' : 'unsupported', null, '供应商参考图片能力不足。'));
        continue;
      }
      decisions.push(decided(requirement.kind, 'applied', 'content[].role=reference_image', `参考图片最多 ${capability.controls.referenceImages.max} 张。`));
      actualControls.push(requirement.kind);
      continue;
    }

    const native = requirement.kind === 'pose' ? capability.controls.pose
      : requirement.kind === 'depth' ? capability.controls.depth
        : requirement.kind === 'mask' ? capability.controls.mask
          : requirement.kind === 'edge' ? capability.controls.edge
            : requirement.kind === 'camera' ? capability.controls.camera : false;
    if (!native) {
      const code = `VIDEO_${requirement.kind.toUpperCase()}_UNSUPPORTED`;
      if (requirement.required) {
        blockers.push({ code, message: `供应商不支持 ${requirement.kind} 原生控制。`, requirement: requirement.kind });
        decisions.push(decided(requirement.kind, 'blocked', null, '硬性强约束无法真实发送，未提交付费请求。'));
        controlIssues.push(issue(spec, code, `供应商不支持 ${requirement.kind} 原生控制，不能把提示词描述当作已生效。`,
          'upstream_input', true));
      } else {
        decisions.push(decided(requirement.kind, 'unsupported', null, '仅提示词描述，未声称已使用该强约束。'));
      }
      continue;
    }
    if (!requirement.artifact) {
      if (requirement.required) blockers.push({ code: 'CONTROL_ARTIFACT_MISSING', message: '缺少强约束控制产物。', requirement: requirement.kind });
      decisions.push(decided(requirement.kind, requirement.required ? 'blocked' : 'unsupported', null, '没有强约束产物引用。'));
      continue;
    }
    const artifactRef = requirement.artifact;
    const artifact = input.directorArtifacts.find(item => item.id === artifactRef.id);
    if (!artifact) {
      if (requirement.required) blockers.push({ code: 'CONTROL_ARTIFACT_NOT_FOUND', message: '强约束产物不存在。', requirement: requirement.kind });
      decisions.push(decided(requirement.kind, requirement.required ? 'blocked' : 'unsupported', null, '强约束产物无法解析。'));
      continue;
    }
    decisions.push(decided(requirement.kind, 'applied', `control.${requirement.kind}`, '供应商支持并真实发送该控制产物。'));
    actualControls.push(requirement.kind);
  }

  const audioKind = spec.audioPolicy === 'provider_scratch' && capability.audioGeneration ? 'provider_scratch' : 'none';
  if (spec.audioPolicy === 'provider_scratch' && !capability.audioGeneration) {
    blockers.push({ code: 'VIDEO_AUDIO_UNSUPPORTED', message: '供应商不支持音频生成。', requirement: 'first_frame' });
    controlIssues.push(issue(spec, 'VIDEO_AUDIO_UNSUPPORTED', '请求了供应商临时音轨，但模型不支持音频生成。', 'upstream_input', true));
  }

  const operationKey = `video_${canonicalDigest({
    snapshotDigest: spec.productionInputSnapshotDigest, shotId: spec.shotId, candidateIndex: spec.candidate.index,
    capabilityRevision: spec.providerCapabilityRevisionId, modelRevision: spec.modelRevision,
    controlDigests: spec.controls.filter(item => item.artifact).map(item => ({ kind: item.kind, digest: item.artifact!.digest })),
    duration: spec.params.durationSeconds, ratio: spec.params.ratio, resolution: spec.params.resolution,
    seed: spec.params.seed, audioPolicy: spec.audioPolicy,
  })}`;

  // Reference images are not duplicated here: the caller's ordered asset list is
  // already frozen in the spec; this compiler only validates the capability gate.
  return {
    plan: {
      specId: spec.id, operationKey, decisions, blockers, actualControls, audioKind,
      providerControls: { firstFrameObjectVersionId: firstFrameObjectVersionId.value,
        lastFrameObjectVersionId: lastFrameObjectVersionId.value, referenceObjectVersionIds },
    },
    issues: controlIssues,
  };
}

/** Only explicit, named repair actions may authorize another paid candidate. */export function assertRepairPlanDiscipline(actions: readonly string[]): void {
  const allowed = new Set(['regenerate_control_frame', 'adjust_named_constraint', 'regenerate_candidate',
    'reevaluate', 'reassign_neighbor_candidate', 'manual_review']);
  if (!actions.length || actions.some(action => !allowed.has(action))) {
    throw new Error('RepairPlan contains an unbounded or unknown action.');
  }
}
