import {
  ORGANIZER_HEADSHOT_ACCEPTED_TYPES,
  ORGANIZER_HEADSHOT_MAX_BYTES,
  type SpeakerAsset,
  type SpeakerSession,
} from "./api";

export type OrganizerHeadshotUploadStatus = "idle" | "busy" | "success" | "error";

export function acceptedSpeakerSessions(
  sessions: readonly SpeakerSession[],
): readonly SpeakerSession[] {
  return sessions.filter((session) => session.status.trim().toLowerCase() === "accepted");
}

export function organizerHeadshotSessionId(
  sessions: readonly SpeakerSession[],
  requestedSessionId: string | null | undefined,
): string | null {
  const eligibleSessions = acceptedSpeakerSessions(sessions);
  if (eligibleSessions.length === 1) return eligibleSessions.at(0)?.sessionId ?? null;
  return requestedSessionId !== null &&
    requestedSessionId !== undefined &&
    eligibleSessions.some((session) => session.sessionId === requestedSessionId)
    ? requestedSessionId
    : null;
}

export function validateOrganizerHeadshotFile(file: File): string | null {
  const contentType = file.type.trim().toLowerCase();
  if (
    !ORGANIZER_HEADSHOT_ACCEPTED_TYPES.includes(
      contentType as (typeof ORGANIZER_HEADSHOT_ACCEPTED_TYPES)[number],
    )
  ) {
    return "Choose a JPEG, PNG, or WebP image.";
  }
  if (file.size > ORGANIZER_HEADSHOT_MAX_BYTES) {
    return "Headshots must be 5 MB or smaller.";
  }
  return null;
}

export function organizerHeadshotPreviewKey(
  participantId: string | null | undefined,
  assetId: string | null | undefined,
  asset: Pick<SpeakerAsset, "contentType" | "status"> | null,
): string | null {
  if (
    participantId === null ||
    participantId === undefined ||
    assetId === null ||
    assetId === undefined
  ) {
    return null;
  }
  return [
    participantId,
    assetId,
    asset?.status ?? "unknown",
    asset === null ? "" : asset.contentType.trim().toLowerCase(),
  ].join("\u0000");
}

export function organizerHeadshotPreviewRequestKey(
  sourceVersion: number,
  retry: number,
  participantId: string | null | undefined,
  assetId: string | null | undefined,
  asset: Pick<SpeakerAsset, "contentType" | "status"> | null,
): string | null {
  const previewKey = organizerHeadshotPreviewKey(participantId, assetId, asset);
  return previewKey === null ? null : `${sourceVersion}:${retry}:${previewKey}`;
}

export function organizerHeadshotPreviewPath(value: string): string | null {
  const candidate = value.trim();
  if (!candidate.startsWith("/api/")) return null;
  try {
    const base = "https://same-origin.invalid";
    const resolved = new URL(candidate, base);
    return resolved.origin === base && resolved.pathname.startsWith("/api/") ? candidate : null;
  } catch {
    return null;
  }
}
