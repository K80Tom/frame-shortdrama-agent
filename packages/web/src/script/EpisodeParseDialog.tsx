import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Sparkles, X } from 'lucide-react';
import type { ScriptEpisode } from '@lyra/shared';
import { newCommandId } from './workbench-logic';

export interface EpisodeParseDialogSubmit {
  rawText: string;
  overwriteConfirmed: boolean;
  allowPaid: boolean;
  commandId: string;
}

interface EpisodeParseDialogProps {
  open: boolean;
  episode: ScriptEpisode | null;
  existingSceneCount: number;
  initialRawText?: string;
  busy?: boolean;
  modelLabel?: string;
  submitError?: string;
  onClose: () => void;
  onSubmit: (input: EpisodeParseDialogSubmit) => void;
}

export function getEpisodeParseValidationError(input: {
  rawText: string;
  existingSceneCount: number;
  overwriteConfirmed: boolean;
  approved: boolean;
}): string {
  if (!input.rawText.trim()) return '请粘贴该集的剧本原文。';
  if (input.existingSceneCount > 0 && !input.overwriteConfirmed) {
    return '该集已有场次，请先勾选「确认覆盖现有数据」。';
  }
  if (!input.approved) return '请先勾选模型调用确认。';
  return '';
}

/**
 * 单集 AI 解析弹窗：
 * - 已有场次时展示黄色警告与强制覆盖复选框，未勾选禁止提交；
 * - 付费调用必须勾选人工确认，前端不静默扣费；
 * - commandId 在一次会话内生成并稳定复用，网络重试不重复建单；
 * - 解析中 Loading 禁用按钮，防重复点击。
 */
export function EpisodeParseDialog({ open, episode, existingSceneCount, initialRawText, busy,
  modelLabel, submitError, onClose, onSubmit }: EpisodeParseDialogProps) {
  const [rawText, setRawText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const commandIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRawText(initialRawText ?? '');
    setConfirmed(false);
    setApproved(false);
    setError('');
    // 切换到另一集时换新命令 ID；同一集的重试沿用既有 ID。
    commandIdRef.current = null;
  }, [open, episode?.id, initialRawText]);

  if (!open || !episode) return null;

  const needsOverwrite = existingSceneCount > 0;
  const visibleError = error || submitError;

  function ensureCommandId(): string {
    if (!commandIdRef.current) commandIdRef.current = newCommandId();
    return commandIdRef.current;
  }

  function handleSubmit() {
    if (busy) return;
    const validationError = getEpisodeParseValidationError({
      rawText, existingSceneCount, overwriteConfirmed: confirmed, approved,
    });
    if (validationError) { setError(validationError); return; }
    setError('');
    onSubmit({
      rawText: rawText.trim(),
      overwriteConfirmed: needsOverwrite && confirmed,
      allowPaid: true,
      commandId: ensureCommandId(),
    });
  }

  function handleClose() {
    if (busy) return;
    onClose();
  }

  return <div className="script-dialog-layer" role="presentation">
    <div className="script-dialog-overlay" onClick={handleClose} />
    <div className="script-dialog-panel" role="dialog" aria-modal="true"
      aria-label={`AI 解析 · 第 ${episode.episodeNumber} 集`}>
      <header className="script-dialog-head">
        <div className="script-dialog-title">
          <Sparkles size={17} />
          <h2>AI 解析 · 第 {episode.episodeNumber} 集</h2>
        </div>
        <button type="button" className="script-dialog-close" aria-label="关闭解析弹窗"
          disabled={busy} onClick={handleClose}>
          <X size={16} />
        </button>
      </header>

      {needsOverwrite && <div className="script-dialog-warn" data-testid="overwrite-warning">
        <AlertTriangle size={16} className="script-dialog-warn-icon" />
        <div>
          <p><strong>该集已有 {existingSceneCount} 个场次</strong></p>
          <p>AI 解析将覆盖现有的场次和对白数据；未勾选确认前不能提交。</p>
          <label className="script-dialog-warn-check">
            <input type="checkbox" checked={confirmed} disabled={busy}
              onChange={event => setConfirmed(event.target.checked)} />
            <span>我已了解，确认覆盖现有数据</span>
          </label>
        </div>
      </div>}

      <div className="script-dialog-body">
        <label className="script-dialog-field">
          <span>该集剧本原文 <span className="required">*</span></span>
          <textarea aria-label="该集剧本原文" rows={10} value={rawText} disabled={busy}
            placeholder="在此粘贴该集的剧本原文，AI 将解析为结构化的场次和对白数据……"
            onChange={event => setRawText(event.target.value)} />
        </label>

        <label className="parse-approval script-dialog-pay">
          <input type="checkbox" checked={approved} disabled={busy}
            onChange={event => setApproved(event.target.checked)} />
          <span>我确认调用 <strong>{modelLabel ?? '解析模型'}</strong> 解析并写入当前集；同名资产直接复用，新识别资产自动入库，Lyra 将保存新的不可变版本。</span>
        </label>

        {visibleError && <p className="project-error" role="alert">{visibleError}</p>}
      </div>

      <footer className="script-dialog-foot">
        <button type="button" className="button-secondary" disabled={busy} onClick={handleClose}>取消</button>
        <button type="button" className="button-primary" disabled={Boolean(busy)} onClick={handleSubmit}>
          <Sparkles size={15} />
          {busy ? '正在解析并写入…' : '开始解析'}
        </button>
      </footer>
    </div>
  </div>;
}
