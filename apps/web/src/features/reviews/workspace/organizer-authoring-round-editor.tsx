"use client";
import { TemporalPicker } from "@/components/ui/temporal-picker";
import { Button } from "../../../components/ui/button";
import styles from "../review-workspace.module.css";
import type { ApiPlan } from "./api-api-plan";
import type { OrganizerAuthoringController } from "./organizer-authoring-controller";
import { OrganizerCriterionEditor } from "./organizer-authoring-criterion-editor";
import { OrganizerRoundTargeting } from "./organizer-authoring-round-targeting";
import {
  reviewLocalValue,
  reviewRoundScheduleField,
  reviewTemporalConstraints,
} from "./review-temporal-policy";
export function OrganizerRoundEditor({
  controller,
  round,
  roundIndex,
}: Readonly<{
  controller: OrganizerAuthoringController;
  round: ApiPlan["rounds"][number];
  roundIndex: number;
}>) {
  const { busy, status, rounds, updateRound, addCriterion, removeRound, setTemporalFieldValidity } =
    controller;
  const { eventTimeZone, eventStartsAt, eventEndsAt } = controller.seed;
  const constraints =
    eventTimeZone === undefined || eventStartsAt === undefined || eventEndsAt === undefined
      ? undefined
      : reviewTemporalConstraints({
          timeZone: eventTimeZone,
          startsAt: eventStartsAt,
          endsAt: eventEndsAt,
        });
  const originalRound = controller.seed.sourceRounds?.find(
    (candidate) => candidate.id === round.id,
  );
  return (
    <fieldset
      className={`${styles.scoreCard} ${styles.authoringRoundCard}`}
      data-authoring-round=""
      key={round.id}
      disabled={busy || status !== "draft"}
    >
      <legend>
        <span>Round {roundIndex + 1}</span>
        <strong>{round.name}</strong>
      </legend>
      <div className={styles.formField}>
        <label htmlFor={`${round.id}-name`}>Round name</label>
        <input
          id={`${round.id}-name`}
          value={round.name}
          onChange={(event) => {
            const nextName = event.currentTarget.value;
            updateRound(roundIndex, (current) => ({
              ...current,
              name: nextName,
            }));
          }}
        />
      </div>
      <div className={styles.formField}>
        <label htmlFor={`${round.id}-rubric`}>Rubric name</label>
        <input
          id={`${round.id}-rubric`}
          value={round.rubric.name}
          onChange={(event) => {
            const nextRubricName = event.currentTarget.value;
            updateRound(roundIndex, (current) => ({
              ...current,
              rubric: {
                ...current.rubric,
                name: nextRubricName,
              },
            }));
          }}
        />
      </div>
      <TemporalPicker
        id={`${round.id}-schedule`}
        mode="range"
        precision="date-time"
        startValue={round.opensAt ?? ""}
        endValue={round.closesAt ?? ""}
        valueTimeZone={eventTimeZone}
        startLabel="Round opens"
        endLabel="Round closes"
        eyebrow={`Round ${roundIndex + 1} schedule`}
        description="Choose the review window directly on the calendar."
        minimumDateTime={constraints?.minimum}
        maximumDateTime={constraints?.maximum}
        unchangedValues={
          eventTimeZone === undefined
            ? undefined
            : [originalRound?.opensAt, originalRound?.closesAt]
                .filter((value): value is string => value != null && value !== "")
                .map((value) => reviewLocalValue(value, eventTimeZone))
        }
        clearable
        disabled={busy || status !== "draft"}
        onChange={({ start, end }) => {
          updateRound(roundIndex, (current) => ({
            ...current,
            opensAt: start === "" ? null : start,
            closesAt: end === "" ? null : end,
          }));
        }}
        onValidityChange={(isValid) =>
          setTemporalFieldValidity(reviewRoundScheduleField(round.id), isValid)
        }
      />
      <div className={styles.formField}>
        <label htmlFor={`${round.id}-anonymization`}>Anonymization / blind review</label>
        <select
          id={`${round.id}-anonymization`}
          value={round.anonymization ?? (round.blindReview ? "double" : "none")}
          onChange={(event) => {
            const nextAnonymization = event.currentTarget.value as "none" | "single" | "double";
            updateRound(roundIndex, (current) => ({
              ...current,
              anonymization: nextAnonymization,
              blindReview: nextAnonymization !== "none",
            }));
          }}
        >
          <option value="none">No anonymization</option>
          <option value="single">Single-blind</option>
          <option value="double">Double-blind</option>
        </select>
      </div>
      <div className={styles.formField}>
        <label htmlFor={`${round.id}-ai-triage`}>
          <input
            id={`${round.id}-ai-triage`}
            type="checkbox"
            checked={round.aiTriageEnabled === true}
            onChange={(event) => {
              const aiTriageEnabled = event.currentTarget.checked;
              updateRound(roundIndex, (current) => ({ ...current, aiTriageEnabled }));
            }}
          />
          Enable organizer AI triage
        </label>
        <p>
          Organizers generate one shared advisory scorecard per submission; reviewers never see it.
        </p>
      </div>
      <OrganizerRoundTargeting controller={controller} round={round} roundIndex={roundIndex} />
      <section className={styles.criteriaList} aria-label={`${round.name} criteria authoring`}>
        {round.rubric.criteria.map((criterion, criterionIndex) => (
          <OrganizerCriterionEditor
            key={criterion.id}
            controller={controller}
            round={round}
            roundIndex={roundIndex}
            criterion={criterion}
            criterionIndex={criterionIndex}
          />
        ))}
      </section>
      <Button
        type="button"
        variant="outline"
        onClick={() => addCriterion(roundIndex)}
        disabled={busy || status !== "draft"}
      >
        Add criterion
      </Button>
      {rounds.length > 1 ? (
        <Button
          type="button"
          variant="destructive"
          onClick={() => removeRound(roundIndex)}
          disabled={busy || status !== "draft"}
        >
          Remove round
        </Button>
      ) : null}
    </fieldset>
  );
}
