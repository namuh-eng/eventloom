"use client";

import { useMemo, useState } from "react";
import {
  StatusBadge,
  WorkspaceHeader,
  WorkspaceListDetail,
  WorkspaceState,
  WorkspaceSurface,
} from "@/components/workspace";
import type { ParticipantSafeGuideFailure } from "./portal-provider-model";
import { PublishedGuideArticle } from "./portal-published-content";
import styles from "./portal-workspace.module.css";
import type { PortalResource, PortalWikiPage } from "./types";

type GuideItem = {
  readonly kind: "Resource" | "Guide";
  readonly item: PortalResource | PortalWikiPage;
};

export interface EventGuideWorkspaceViewProps {
  readonly eventName: string;
  readonly available: boolean;
  readonly resources: readonly PortalResource[];
  readonly resourceError?: ParticipantSafeGuideFailure | null;
  readonly wiki: readonly PortalWikiPage[];
  readonly wikiError?: ParticipantSafeGuideFailure | null;
}

export function EventGuideWorkspaceView({
  eventName,
  available,
  resources,
  resourceError = null,
  wiki,
  wikiError = null,
}: EventGuideWorkspaceViewProps) {
  const items = useMemo<readonly GuideItem[]>(
    () => [
      ...[...resources]
        .sort((left, right) => left.order - right.order)
        .map((item) => ({ kind: "Resource" as const, item })),
      ...[...wiki]
        .sort((left, right) => left.order - right.order)
        .map((item) => ({ kind: "Guide" as const, item })),
    ],
    [resources, wiki],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find(({ item }) => item.id === selectedId) ?? items[0] ?? null;

  return (
    <div className={styles.page}>
      <WorkspaceHeader
        eyebrow="Participant reference"
        title="Event guide"
        description="Published resources and wiki guidance in one safe, read-only reference surface."
        metadata={
          <>
            <span>{eventName}</span>
            <span>{items.length} published items</span>
          </>
        }
      />

      {available && resourceError ? (
        <WorkspaceState
          variant="error"
          title="Event resources unavailable"
          description={
            <>
              {resourceError.message}
              {resourceError.supportId === null ? null : (
                <>
                  <br />
                  <span>Support ID: {resourceError.supportId}.</span>
                </>
              )}
            </>
          }
        />
      ) : null}
      {available && wikiError ? (
        <WorkspaceState
          variant="error"
          title="Event guide pages unavailable"
          description={
            <>
              {wikiError.message}
              {wikiError.supportId === null ? null : (
                <>
                  <br />
                  <span>Support ID: {wikiError.supportId}.</span>
                </>
              )}
            </>
          }
        />
      ) : null}
      {!available ? (
        <WorkspaceState
          variant="error"
          title="Event guide unavailable"
          description="This event context did not grant access to published participant guidance."
        />
      ) : items.length === 0 && resourceError === null && wikiError === null ? (
        <WorkspaceState
          variant="empty"
          title="Nothing published yet"
          description="The event team has not published resources or guide pages for participants."
        />
      ) : items.length > 0 ? (
        <WorkspaceSurface
          title="Published guide"
          description="Content is supplied by the event team and rendered with unsafe markup and URLs removed."
        >
          <WorkspaceListDetail
            listLabel="Event guide contents"
            detailLabel={selected?.item.title ?? "Published guide detail"}
            list={
              <ul className={styles.guideList}>
                {items.map(({ kind, item }) => (
                  <li key={`${kind}-${item.id}`}>
                    <button
                      className={styles.guideButton}
                      type="button"
                      aria-current={item.id === selected?.item.id ? "true" : undefined}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>{kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            }
            detail={
              selected ? (
                <div className={styles.detail}>
                  <StatusBadge tone={selected.kind === "Guide" ? "info" : "neutral"}>
                    {selected.kind}
                  </StatusBadge>
                  <PublishedGuideArticle item={selected.item} />
                </div>
              ) : (
                <WorkspaceState
                  variant="empty"
                  title="Select a guide item"
                  description="Choose published guidance from the contents list."
                />
              )
            }
          />
        </WorkspaceSurface>
      ) : null}
    </div>
  );
}
