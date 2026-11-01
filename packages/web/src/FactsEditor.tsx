import {
  changedEntityFields, draftForEntity, entityDraftKey, entityEvidence, entityGroups,
  type EntityDraft, type EntityDrafts, type FactPlan, type FactValue,
} from './facts-editor';

function originLabel(value: FactValue | null | undefined): string {
  if (!value) return '未填写';
  return value.origin === 'user' ? '人工修改' : value.origin === 'design' ? '设计补充' : '原文提取';
}

export default function FactsEditor({ plan, drafts, disabled, onChange }: {
  plan: FactPlan; drafts: EntityDrafts; disabled: boolean; onChange: (key: string, draft: EntityDraft) => void;
}) {
  return <div className="facts-editor">
    {entityGroups.map(group => <section className="facts-group" key={group.kind} aria-labelledby={`facts-${group.kind}`}>
      <header><div><h3 id={`facts-${group.kind}`}>{group.label}<span>{plan.content[group.key].length}</span></h3><p>{group.hint}</p></div></header>
      {plan.content[group.key].length === 0 && <p className="facts-empty">当前版本未提取到{group.label}。本轮支持校对已有条目，暂不新增或删除实体。</p>}
      <div className="facts-entity-grid">{plan.content[group.key].map((entity, index) => {
        const key = entityDraftKey(group.kind, entity.id);
        const draft = drafts[key] ?? draftForEntity(entity);
        const changed = changedEntityFields(entity, draft);
        const locks = plan.content.manualLocks.filter(lock => lock.targetType === 'entity' && lock.targetId === entity.id).flatMap(lock => lock.fields);
        const evidence = entityEvidence(entity);
        const badge = (field: 'name' | 'aliases' | 'description') => {
          const value = field === 'aliases' ? entity.aliases.find(alias => alias.origin === 'user') ?? entity.aliases[0] : entity[field];
          return <small className={changed.includes(field) ? 'facts-origin unsaved' : locks.includes(field) || value?.origin === 'user' ? 'facts-origin manual' : 'facts-origin'}>{changed.includes(field) ? '待保存修改' : locks.includes(field) ? '人工修改 · 已记录' : originLabel(value)}</small>;
        };
        return <article className={`facts-entity${changed.length ? ' is-dirty' : ''}`} key={entity.id}>
          <div className="facts-entity-head"><span>{group.label} {String(index + 1).padStart(2, '0')}</span><small>{changed.length ? '尚未保存' : '已保存'}</small></div>
          <label htmlFor={`${key}-name`}><span>名称 {badge('name')}</span><input id={`${key}-name`} value={draft.name} disabled={disabled} maxLength={20_000} onChange={event => onChange(key, { ...draft, name: event.target.value })} /></label>
          <label htmlFor={`${key}-aliases`}><span>别名 {badge('aliases')}</span><textarea id={`${key}-aliases`} className="facts-aliases" rows={2} value={draft.aliases} disabled={disabled} placeholder="每行一个别名；没有可留空" onChange={event => onChange(key, { ...draft, aliases: event.target.value })} /></label>
          <label htmlFor={`${key}-description`}><span>说明 {badge('description')}</span><textarea id={`${key}-description`} className="facts-description" rows={3} value={draft.description} disabled={disabled} maxLength={20_000} placeholder="核对身份、地点或物件说明；人工补充会单独标记来源" onChange={event => onChange(key, { ...draft, description: event.target.value })} /></label>
          <details className="facts-evidence" open><summary>原文依据 <span>{evidence.length} 段 · 只读</span></summary>{evidence.map(({ ref, labels }) => <div key={`${ref.scriptVersionId}:${ref.start}:${ref.end}`}><small>{labels.join(' / ')} · 码点 {ref.start}–{ref.end}</small><blockquote>{ref.quote}</blockquote></div>)}{!evidence.length && <p>没有可显示的原文引用，请人工核对。</p>}</details>
        </article>;
      })}</div>
    </section>)}
  </div>;
}
