import type { NavigationDataCache } from "@/lib/navigation-data-cache";
import type {
  SessionRecord,
  SessionSpeakerCandidate,
  SessionsApi,
  SessionTaxonomyOption,
} from "./api";

export interface SessionsWorkspaceCacheBundle {
  readonly sessions: readonly SessionRecord[];
  readonly speakers: readonly SessionSpeakerCandidate[];
  readonly tracks: readonly SessionTaxonomyOption[];
  readonly formats: readonly SessionTaxonomyOption[];
  readonly trackError: string | null;
  readonly formatError: string | null;
}

export function sessionsWorkspaceCacheKey(organizationId: string, eventId: string): string {
  return `sessions:workspace:${organizationId.trim()}:${eventId.trim()}`;
}

export function sessionsWorkspaceCacheTags(
  organizationId: string,
  eventId: string,
): readonly string[] {
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  return [
    `organization:${normalizedOrganizationId}`,
    `event:${normalizedEventId}`,
    `sessions:${normalizedEventId}`,
  ];
}

function abortedError(): DOMException {
  return new DOMException("The session request was aborted.", "AbortError");
}
function taxonomyError(error: unknown, resource: "track" | "format"): string {
  return error instanceof Error
    ? error.message
    : `The session ${resource} taxonomy request could not be completed.`;
}

export interface SessionTaxonomyLoadResult {
  readonly options: readonly SessionTaxonomyOption[];
  readonly error: string | null;
}

export async function loadSessionTracks(api: SessionsApi): Promise<SessionTaxonomyLoadResult> {
  try {
    return { options: await api.listTracks(), error: null };
  } catch (error) {
    return { options: [], error: taxonomyError(error, "track") };
  }
}

export async function loadSessionFormats(api: SessionsApi): Promise<SessionTaxonomyLoadResult> {
  try {
    return { options: await api.listFormats(), error: null };
  } catch (error) {
    return { options: [], error: taxonomyError(error, "format") };
  }
}

export async function loadSessionsWorkspaceBundle(
  api: SessionsApi,
  cache: NavigationDataCache | null,
  key: string,
  tags: readonly string[],
  signal?: AbortSignal,
  fresh = false,
): Promise<SessionsWorkspaceCacheBundle> {
  const previous = cache?.peek<SessionsWorkspaceCacheBundle>(key);
  const load = async (): Promise<SessionsWorkspaceCacheBundle> => {
    const sessionsRequest = cache === null ? api.list(signal) : api.list();
    const speakersRequest = cache === null ? api.listSpeakers(signal) : api.listSpeakers();
    const tracksRequest = cache === null ? api.listTracks(signal) : api.listTracks();
    const formatsRequest = cache === null ? api.listFormats(signal) : api.listFormats();
    const [sessions, speakers, tracksResult, formatsResult] = await Promise.all([
      sessionsRequest,
      speakersRequest,
      Promise.resolve(tracksRequest).then(
        (tracks) => ({ tracks, trackError: null }),
        (error: unknown) => ({
          tracks: previous?.tracks ?? ([] as readonly SessionTaxonomyOption[]),
          trackError: taxonomyError(error, "track"),
        }),
      ),
      Promise.resolve(formatsRequest).then(
        (formats) => ({ formats, formatError: null }),
        (error: unknown) => ({
          formats: previous?.formats ?? ([] as readonly SessionTaxonomyOption[]),
          formatError: taxonomyError(error, "format"),
        }),
      ),
    ]);
    if (cache === null && signal?.aborted) throw abortedError();
    return {
      sessions,
      speakers,
      tracks: tracksResult.tracks,
      formats: formatsResult.formats,
      trackError: tracksResult.trackError,
      formatError: formatsResult.formatError,
    };
  };
  if (cache === null) return load();
  return cache.read({ key, tags, load, fresh });
}
