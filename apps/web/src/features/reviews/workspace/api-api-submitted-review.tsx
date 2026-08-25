"use client";

export interface ApiSubmittedReview {
  readonly id: string;
  readonly planId: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly reviewerId: string;
  readonly comment: string;
  readonly submittedAt: string;
}
