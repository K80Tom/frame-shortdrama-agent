export interface PlanIssueField {
  objectKind: string;
  objectId: string | null;
  fieldPath: string;
  expected: string | null;
  actual: string | null;
}

export interface PlanCheckIssue {
  id: string;
  code: string;
  message: string;
  sourceRefs: Array<{ quote: string }>;
  scope?: { kind: string; targetId: string | null; field?: PlanIssueField };
}

/** Blocking fact-check issues, including the field path when the check recorded one. */
export function PlanIssueList({ issues }: { issues: PlanCheckIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="production-issues">
      <h3>待处理问题</h3>
      {issues.map(issue => {
        const field = issue.scope?.field;
        return (
          <div key={issue.id}>
            <strong>{issue.message}</strong>
            <small>{issue.code}</small>
            {field?.fieldPath && <small className="production-issue-location" data-field-path={field.fieldPath}>{field.objectKind}{field.objectId ? ` ${field.objectId}` : ''} · {field.fieldPath}</small>}
            {field?.expected != null && <small>期望：{field.expected}</small>}
            {field?.actual != null && <small>实际：{field.actual}</small>}
            {issue.sourceRefs.map((ref, index) => <blockquote key={index}>{ref.quote}</blockquote>)}
          </div>
        );
      })}
    </div>
  );
}
