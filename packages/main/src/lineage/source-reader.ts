import type {
  LineageEdgeType, LineageGap, LineageKind, LineageRetention, LineageSourceRef, LineageVisibility,
} from '@lyra/shared';
import type { TenantDataEvent } from '../data/tenant-event';

/**
 * 只读权威来源读取器。血缘 projector 只通过它从权威记录里提取 SourceRef /
 * inputManifest / provenance / 完整链接集；接口没有任何写方法，投影结果绝不回写业务事实。
 *
 * 生产实现由 main 的只读查询实现注入；离线测试用内存夹具实现。读取发生在
 * “首次投影”那一刻并把 sanitized 事实集快照下来；重复 replay 时 projector 先判重、
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

/** 已解析（或明确缺失）的节点引用；用于表达任意多跳关系，而不只当前事实的入边。 */
export interface AuthoritativeNodeRef {
  kind: LineageKind;
  businessId: string;
  revisionId: string | null;
  /** false 表示权威记录中找不到该引用，生成 unknown 占位节点。 */
  present?: boolean;
  ref?: LineageSourceRef;
  digest?: string | null;
  occurredAt?: string;
  recordedAt?: string;
  retention?: LineageRetention;
  visibility?: LineageVisibility;
  authorization?: string;
}

/** 任意 from→to 关系边；投影层只做身份/摘要校验，不推断不存在的边。 */
export interface AuthoritativeLink {
  edgeType: LineageEdgeType;
  from: AuthoritativeNodeRef;
  to: AuthoritativeNodeRef;
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
  /** 权威记录所属 workspace；V1 legacy 事件投影真实租户行时必须用它隔离节点 ID。 */
  workspaceId?: string;
  inputs: AuthoritativeInputRef[];
  /** 完整多跳关系；用于构建“剧本→镜头→资产→成片”的双向图谱。 */
  links?: AuthoritativeLink[];
  /** 当前事实的显式 gap（例如声明的冻结输入缺失）。 */
  gap?: LineageGap;
}

export interface SourceLineageReader {
  /**
   * 定位事件聚合对应的权威事实。返回 null 表示连当前事实自身都无法在权威
   * 记录中定位（投影层据此生成 unknown 根节点，而不是猜）。
   */
  resolve(event: TenantDataEvent): Promise<AuthoritativeFact | null>;
}
