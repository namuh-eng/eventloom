export interface ApiAggregate {
  readonly planId: string;
  roundId: string;
  roundRevision: number;
  rubricRevision: number;
  submissionId: string;
  submittedReviewCount: number;
  expectedReviewCount: number;
  averageWeightedTotal: number | null;
  possibleWeightedTotal: number;
}
