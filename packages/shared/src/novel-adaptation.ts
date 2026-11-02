/** A screenplay adaptation pins immutable chapter revisions in reading order. */
export interface NovelAdaptationSelection { chapterId: string; revisionId: string }
export interface NovelAdaptationRequest { chapters: NovelAdaptationSelection[] }
export interface AdoptNovelAdaptationRequest extends NovelAdaptationRequest { digest: string }
export interface NovelAdaptationSource {
  kind: 'novelAdaptation';
  format: 'chapter-script/1';
  url: string;
  title: string;
  documentId: string;
  documentSha256: string;
  chapters: NovelAdaptationSelection[];
}
export interface NovelAdaptationPreview {
  title: string;
  source: NovelAdaptationSource;
  rawText: string;
  digest: string;
}
export interface NovelAdaptationResult { projectId: string; scriptVersionId: string }
