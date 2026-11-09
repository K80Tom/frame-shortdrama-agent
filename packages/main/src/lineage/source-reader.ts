import type {
  LineageEdgeType, LineageKind, LineageRetention, LineageSourceRef, LineageVisibility,
} from '@lyra/shared';
import type { DataEventV1 } from '@lyra/shared';

/**
 * 只读权威来源读取器。血缘 projector 只通过它从权威记录里提取 SourceRef /
 * inputManifest / provenance；接口没有任何写方法，投影结果绝不回写业务事实。
 *
 * 生产实现由各业务 repository 注入；离线测试用内存夹具实现。读取发生在“首次
 * 投影”那一刻并把 sanitized 事实集快照下来；重复 replay 时 projector 先判重、
 * 不会再调用本读取器，因此不会拿当前可变业务状态冒充历史。
 */

export interface AuthoritativeInputRef {
  kind: LineageKind;
  businessId: string;
  revisionId: string | null;
  edgeType: LineageEdgeType;
  /** false 表示该上游引用在权威记录里缺失，形成 unknown gap。 */
  present: boolean;
  /**
   * 该输入相对当前事实的方向：true 表示输入是上游（from=输入, to=当前事实）；
   * false 表示当前事实是上游（from=当前事实, to=输入），用于 validated-by 等关系。
   */
  factIsTo: boolean;
  digest?: string | null;
  ref?: LineageSourceRef;
  occurredAt?: string;
  recordedAt?: string;
  retention?: LineageRetention;
  visibility?: LineageVisibility;
  authorization?: string;
}

export interface AuthoritativeFact {
  kind: LineageKind;
  businessId: string;
  revisionId: string | null;
  ref: LineageSourceRef;
  /** 权威摘要；digestMismatch=true 时表示与已存历史不一致。 */
  digest: string;
  digestMismatch?: { expected: string; actual: string };
  occurredAt: string;
  recordedAt: string;
  retention: LineageRetention;
  visibility: LineageVisibility;
  authorization: string;
  inputs: AuthoritativeInputRef[];
}

export interface SourceLineageReader {
  /**
   * 定位事件聚合对应的权威事实。返回 null 表示连当前事实自身都无法在权威
   * 记录中定位（投影层据此生成 unknown 根节点，而不是猜）。
   */
  resolve(event: DataEventV1): Promise<AuthoritativeFact | null>;
}
