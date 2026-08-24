"use client";
import styles from "../review-workspace.module.css";
import type { OrganizerAuthoringController } from "./organizer-authoring-controller";
import { OrganizerDraftPlan } from "./organizer-authoring-draft-plan";
import { OrganizerPlanActionsView } from "./organizer-authoring-plan-actions-view";
import { OrganizerReadonlyPlan } from "./organizer-authoring-readonly-plan";
export function OrganizerAuthoringWorkbench({
  controller,
}: Readonly<{ controller: OrganizerAuthoringController }>) {
  return (
    <div className={styles.authoringWorkbench} data-layout="plan-authoring-workbench">
      <OrganizerPlanActionsView controller={controller} />
      <div className={styles.authoringMain}>
        {controller.isDraft ? (
          <OrganizerDraftPlan controller={controller} />
        ) : (
          <OrganizerReadonlyPlan controller={controller} />
        )}
      </div>
    </div>
  );
}
