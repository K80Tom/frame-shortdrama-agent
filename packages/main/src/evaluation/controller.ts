import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { parseEvaluationDatasetId, parseEvaluationDatasetRevisionId, parseEvaluationRubricId,
  parseEvaluationRubricRevisionId } from '@lyra/shared';
import type { EvaluationService } from './service';

export const EVALUATION_SERVICE = Symbol('EVALUATION_SERVICE');

/** Controller 只校验路径与基本格式；生命周期规则全部在 Service/Repository。 */
@Controller('api/evaluation')
export class EvaluationController {
  constructor(@Inject(EVALUATION_SERVICE) private readonly evaluation: EvaluationService) {}

  @Get('datasets') listDatasets() { return this.evaluation.listDatasets(); }

  @Post('datasets') @HttpCode(200)
  createDataset(@Body() body: unknown) { return this.evaluation.createDataset(body); }

  @Get('datasets/:datasetId')
  dataset(@Param('datasetId') datasetId: string) {
    return this.evaluation.getDataset(parseEvaluationDatasetId(datasetId));
  }

  @Get('datasets/:datasetId/revisions')
  datasetRevisions(@Param('datasetId') datasetId: string) {
    return this.evaluation.getDataset(parseEvaluationDatasetId(datasetId));
  }

  @Post('datasets/:datasetId/revisions') @HttpCode(200)
  nextDatasetRevision(@Param('datasetId') datasetId: string, @Body() body: unknown) {
    return this.evaluation.createNextDatasetRevision(parseEvaluationDatasetId(datasetId), body);
  }

  @Get('datasets/:datasetId/revisions/:revisionId')
  datasetRevision(@Param('datasetId') datasetId: string, @Param('revisionId') revisionId: string) {
    return this.evaluation.getDatasetRevision(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId));
  }

  @Post('datasets/:datasetId/revisions/:revisionId/cases') @HttpCode(200)
  appendCases(@Param('datasetId') datasetId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.appendDatasetCases(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId), body);
  }

  @Post('datasets/:datasetId/revisions/:revisionId/freeze') @HttpCode(200)
  freezeDataset(@Param('datasetId') datasetId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.freezeDatasetRevision(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId), body);
  }

  @Post('datasets/:datasetId/revisions/:revisionId/deprecate') @HttpCode(200)
  deprecateDataset(@Param('datasetId') datasetId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.deprecateDatasetRevision(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId), body);
  }

  @Get('datasets/:datasetId/revisions/:revisionId/export')
  exportDataset(@Param('datasetId') datasetId: string, @Param('revisionId') revisionId: string) {
    return this.evaluation.exportDatasetRevision(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId));
  }

  @Post('datasets/import') @HttpCode(200)
  importDataset(@Body() body: unknown) { return this.evaluation.importDatasetJsonl(body); }

  @Get('rubrics') listRubrics() { return this.evaluation.listRubrics(); }

  @Post('rubrics') @HttpCode(200)
  createRubric(@Body() body: unknown) { return this.evaluation.createRubric(body); }

  @Get('rubrics/:rubricId')
  rubric(@Param('rubricId') rubricId: string) {
    return this.evaluation.getRubric(parseEvaluationRubricId(rubricId));
  }

  @Get('rubrics/:rubricId/revisions')
  rubricRevisions(@Param('rubricId') rubricId: string) {
    return this.evaluation.getRubric(parseEvaluationRubricId(rubricId));
  }

  @Post('rubrics/:rubricId/revisions') @HttpCode(200)
  nextRubricRevision(@Param('rubricId') rubricId: string, @Body() body: unknown) {
    return this.evaluation.createNextRubricRevision(parseEvaluationRubricId(rubricId), body);
  }

  @Get('rubrics/:rubricId/revisions/:revisionId')
  rubricRevision(@Param('rubricId') rubricId: string, @Param('revisionId') revisionId: string) {
    return this.evaluation.getRubricRevision(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId));
  }

  @Post('rubrics/:rubricId/revisions/:revisionId/dimensions') @HttpCode(200)
  appendDimensions(@Param('rubricId') rubricId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.appendRubricDimensions(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId), body);
  }

  @Post('rubrics/:rubricId/revisions/:revisionId/freeze') @HttpCode(200)
  freezeRubric(@Param('rubricId') rubricId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.freezeRubricRevision(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId), body);
  }

  @Post('rubrics/:rubricId/revisions/:revisionId/deprecate') @HttpCode(200)
  deprecateRubric(@Param('rubricId') rubricId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    return this.evaluation.deprecateRubricRevision(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId), body);
  }

  @Get('rubrics/:rubricId/revisions/:revisionId/export')
  exportRubric(@Param('rubricId') rubricId: string, @Param('revisionId') revisionId: string) {
    return this.evaluation.exportRubricRevision(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId));
  }

  @Post('rubrics/import') @HttpCode(200)
  importRubric(@Body() body: unknown) { return this.evaluation.importRubricJsonl(body); }

  @Post('usages') @HttpCode(200)
  recordUsage(@Body() body: unknown) { return this.evaluation.recordUsage(body); }
}
