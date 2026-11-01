import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [statePath, rubricPath] = process.argv.slice(2);
if (!statePath || !rubricPath) throw new Error('用法：node scripts/novel-review-compare.mjs state.json rubric.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const rubric = JSON.parse(await readFile(rubricPath, 'utf8'));
const matches = (items, aliases, exact) => items.some(i => aliases.some(alias => {
  const label = i.label.replace(/[（(].*?[）)]/gu, '').trim();
  if (['家门', '屋门', '房门'].includes(alias)) return label.endsWith(alias);
  if (alias === '书' && /书桌|书架/u.test(label)) return false;
  return exact ? label === alias : label.includes(alias);
}));
function metrics(content, chapter, cases) {
  if (!content) return null;
  const entityItems = content.items.filter(i => i.kind !== 'dialogue');
  const groups = {};
  for (const [key, kind] of [['characters', 'character'], ['locations', 'location'], ['presentProps', 'prop'], ['historicalProps', 'prop']]) {
    const allOfKind = entityItems.filter(i => i.kind === kind);
    const eligible = entityItems.filter(i => i.kind === kind && (key !== 'presentProps' || !i.occurrence || i.occurrence === 'present')
      && (key !== 'historicalProps' || !i.occurrence || i.occurrence === 'historical'));
    const missing = cases[key].filter(aliases => !matches(eligible, aliases, key === 'characters' && !aliases.includes('四人'))).map(a => a[0]);
    const missingEntity = cases[key].filter(aliases => !matches(allOfKind, aliases, key === 'characters' && !aliases.includes('四人'))).map(a => a[0]);
    groups[key] = { found: cases[key].length - missing.length, detected: cases[key].length - missingEntity.length,
      total: cases[key].length, missing, missingEntity, scopeMismatch: missing.filter(name => !missingEntity.includes(name)) };
  }
  const points = Array.from(state.source.rawText);
  const refs = content.items.flatMap(i => i.sourceRefs);
  const exactRefs = refs.filter(r => r.documentId === (chapter.documentId ?? state.source.id)
    && r.start >= chapter.start && r.end <= chapter.end && points.slice(r.start, r.end).join('') === r.quote).length;
  const quotes = content.items.filter(i => i.kind === 'dialogue');
  return { items: content.items.length, entityItems: entityItems.length, groups,
    quotes: quotes.length, quoteClassifications: Object.fromEntries([...new Set(quotes.map(q => q.classification))].map(c => [c, quotes.filter(q => q.classification === c).length])),
    sourceRefs: { exact: exactRefs, total: refs.length },
    flaggedItems: content.items.filter(i => i.uncertainty).length,
    modelAnalysis: content.analysis ? { status: content.analysis.status, stages: content.analysis.calls.map(c => c.stage),
      scannedParagraphs: content.analysis.paragraphCoverage.length, issues: content.analysis.issues } : null };
}
const report = { evaluatedAt: new Date().toISOString(), model: state.model, scope: rubric.scope,
  sourceSha256: state.source.contentSha256, sourceId: state.source.id, automatedMetricsAreNotSemanticAccuracy: true,
  chapters: rubric.chapters.map(cases => {
    const old = state.baseline.find(c => c.order === cases.order).revision;
    const current = state.chapters.find(c => c.chapter.order === cases.order);
    return { order: cases.order, oldRevisionId: old.id, newRevisionId: current?.revisions.at(-1)?.id ?? null,
      errorCode: current?.errorCode ?? null,
      // Baseline source IDs differ; compare against its own frozen source identity.
      before: metrics(old.content, { ...current?.chapter, documentId: old.content.items[0]?.sourceRefs[0]?.documentId }, cases),
      newInitial: current ? metrics(current.revisions[0]?.content, current.chapter, cases) : null,
      after: current ? metrics(current.revisions.at(-1)?.content, current.chapter, cases) : null,
      attempt: current?.attempt ?? null };
  }) };
const path = resolve(statePath, '..', 'comparison.json');
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
