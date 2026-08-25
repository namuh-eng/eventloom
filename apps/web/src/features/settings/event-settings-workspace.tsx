"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrganizerEventId } from "@/features/admin/organizer-event-workspace";
import type { NavigationDataCache } from "@/lib/navigation-data-cache";
import { useNavigationDataCache } from "@/lib/navigation-data-cache-provider";
import {
  createEventSettingsApi,
  type EventIdentity,
  type EventSettingsApi,
  EventSettingsApiError,
  type EventSettingsData,
  type EventSettingsResourceKind,
  type RoomInput,
  type TaxonomyInput,
} from "./api";
import { useEventSettingsNavigationCache } from "./event-settings-navigation-cache";
import { isCompleteEventSettingsNavigationCacheSnapshot } from "./event-settings-navigation-cache-model";
import type { EventSettingsSection } from "./event-settings-sections";
import {
  canCommitEventSettingsAsyncCompletion,
  eventSettingsWorkspaceScopeKey,
  loadEventSettingsProgressively,
  normalizeData,
} from "./event-settings-workspace-model";
import { EventSettingsWorkspaceView } from "./event-settings-workspace-views";

export { EventSettingsWorkspaceView };

export type EventSettingsDetailsStatus = "loading" | "loaded" | "error";

export type EventSettingsWorkspaceState =
  | { readonly status: "loading" }
  | { readonly status: "error" | "config-error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly data: EventSettingsData;
      readonly detailsStatus?: EventSettingsDetailsStatus;
      readonly detailsMessage?: string;
    };

export interface EventSettingsWorkspaceActions {
  updateSettings(input: {
    expectedVersion: number;
    statuses: readonly string[];
    agendaEligibleStatuses: readonly string[];
  }): Promise<void>;
  createRoom(input: RoomInput): Promise<void>;
  updateRoom(input: {
    roomId: string;
    expectedVersion: number;
    name: string;
    capacity: number;
    resources: readonly string[];
  }): Promise<void>;
  deleteRoom(roomId: string, expectedVersion: number): Promise<void>;
  createResource(kind: EventSettingsResourceKind, input: TaxonomyInput): Promise<void>;
  updateResource(
    kind: EventSettingsResourceKind,
    input: {
      resourceId: string;
      expectedVersion: number;
      name: string;
      description: string;
    },
  ): Promise<void>;
  deleteResource(
    kind: EventSettingsResourceKind,
    resourceId: string,
    expectedVersion: number,
  ): Promise<void>;
}

export interface EventSettingsWorkspaceViewProps {
  readonly organizationId: string;
  readonly eventId: string;
  readonly eventIdentity?: EventIdentity;
  readonly section?: EventSettingsSection;
  readonly state: EventSettingsWorkspaceState;
  readonly busy?: boolean;
  readonly notice?: string | null;
  readonly actions?: Partial<EventSettingsWorkspaceActions>;
  readonly onRetry?: () => void;
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The event settings request could not be completed.";
}
export function invalidateAgendaCatalogAfterEventSettingsMutation(
  cache: NavigationDataCache | null,
  eventId: string,
): void {
  cache?.invalidate([`agenda:${eventId.trim()}`]);
}
export function eventSettingsMutationInvalidatesAgendaCatalog(
  resourceKind?: EventSettingsResourceKind,
): boolean {
  return resourceKind === undefined || resourceKind === "track" || resourceKind === "format";
}

type PersistMutation = (
  operation: () => Promise<void>,
  successMessage: string,
  invalidateAgendaCatalog?: boolean,
) => Promise<void>;

function createEventSettingsWorkspaceActions(
  api: EventSettingsApi | null,
  eventId: string,
  mutate: PersistMutation,
): EventSettingsWorkspaceActions {
  return {
    updateSettings: async (input) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.updateSettings(eventId, input);
        },
        "Session settings saved and the change was audited.",
        true,
      );
    },
    createRoom: async (input) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.createRoom(eventId, input);
        },
        "Room created.",
        true,
      );
    },
    updateRoom: async (input) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.updateRoom(eventId, input);
        },
        "Room updated.",
        true,
      );
    },
    deleteRoom: async (roomId, expectedVersion) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.deleteRoom(eventId, roomId, expectedVersion);
        },
        "Room deleted.",
        true,
      );
    },
    createResource: async (kind, input) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.createResource(eventId, kind, input);
        },
        `${kind.charAt(0).toUpperCase() + kind.slice(1)} created.`,
        eventSettingsMutationInvalidatesAgendaCatalog(kind),
      );
    },
    updateResource: async (kind, input) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.updateResource(eventId, kind, input);
        },
        `${kind.charAt(0).toUpperCase() + kind.slice(1)} updated.`,
        eventSettingsMutationInvalidatesAgendaCatalog(kind),
      );
    },
    deleteResource: async (kind, resourceId, expectedVersion) => {
      await mutate(
        async () => {
          if (!api) return;
          await api.deleteResource(eventId, kind, resourceId, expectedVersion);
        },
        `${kind.charAt(0).toUpperCase() + kind.slice(1)} deleted.`,
        eventSettingsMutationInvalidatesAgendaCatalog(kind),
      );
    },
  };
}

export interface EventSettingsWorkspaceProps {
  readonly organizationId: string;
  readonly eventId: string;
  readonly section: EventSettingsSection;
  readonly api?: EventSettingsApi;
  readonly initialData?: EventSettingsData;
}
export function EventSettingsWorkspace(props: Readonly<EventSettingsWorkspaceProps>) {
  const eventId = useOrganizerEventId(props.eventId);
  const scopeKey = eventSettingsWorkspaceScopeKey(props.organizationId, eventId);
  return <ScopedEventSettingsWorkspace key={scopeKey} {...props} eventId={eventId} />;
}

function ScopedEventSettingsWorkspace({
  organizationId,
  eventId,
  section,
  api: providedApi,
  initialData,
}: Readonly<EventSettingsWorkspaceProps>) {
  const navigationCache = useEventSettingsNavigationCache();
  const agendaNavigationCache = useNavigationDataCache();
  const cacheScope = useMemo(() => ({ organizationId, eventId }), [eventId, organizationId]);
  const initialCacheSnapshot = useMemo(
    () => navigationCache?.get(cacheScope),
    [cacheScope, navigationCache],
  );
  const initialCachedData = useMemo(() => {
    if (initialCacheSnapshot?.state.status !== "loaded") return undefined;
    try {
      return normalizeData(initialCacheSnapshot.state.data, organizationId, eventId);
    } catch {
      return undefined;
    }
  }, [eventId, initialCacheSnapshot, organizationId]);
  const initialCacheIdentity = initialCacheSnapshot?.eventIdentity;
  const initialCacheIdentityMatchesScope =
    initialCacheIdentity === undefined || initialCacheIdentity.id === eventId;
  const [state, setState] = useState<EventSettingsWorkspaceState>(() => {
    const cachedState = initialCacheSnapshot?.state;
    if (cachedState !== undefined) {
      if (cachedState.status !== "loaded") return cachedState;
      if (initialCachedData !== undefined) {
        return { ...cachedState, data: initialCachedData };
      }
      return {
        status: "config-error",
        message: "The cached event settings response belongs to a different scope.",
      };
    }
    if (initialData) {
      try {
        return { status: "loaded", data: normalizeData(initialData, organizationId, eventId) };
      } catch (error) {
        return { status: "config-error", message: messageFrom(error) };
      }
    }
    return { status: "loading" };
  });
  const [eventIdentity, setEventIdentity] = useState<EventIdentity | undefined>(() =>
    initialCacheIdentityMatchesScope && initialCachedData !== undefined
      ? initialCacheIdentity
      : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const mountedRef = useRef(true);
  const reuseInitialCache =
    initialCacheIdentity !== undefined &&
    initialCacheIdentityMatchesScope &&
    initialCachedData !== undefined &&
    isCompleteEventSettingsNavigationCacheSnapshot(initialCacheSnapshot);

  const api = useMemo(() => {
    if (providedApi) return providedApi;
    try {
      return createEventSettingsApi("", organizationId);
    } catch {
      return null;
    }
  }, [organizationId, providedApi]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersion.current += 1;
    };
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++requestVersion.current;
      const requestIsCurrent = () =>
        canCommitEventSettingsAsyncCompletion(
          requestId,
          requestVersion.current,
          mountedRef.current,
          signal?.aborted ?? false,
        );
      const writeCache = (
        nextState: EventSettingsWorkspaceState,
        identity = !initialCacheIdentityMatchesScope || initialCachedData === undefined
          ? undefined
          : initialCacheIdentity,
      ) => {
        if (!navigationCache) return;
        navigationCache.set(cacheScope, {
          state: nextState,
          ...(identity === undefined ? {} : { eventIdentity: identity }),
        });
      };
      if (!organizationId.trim() || !eventId.trim()) {
        if (requestIsCurrent()) {
          const nextState: EventSettingsWorkspaceState = {
            status: "config-error",
            message: "An organization and event context are required.",
          };
          setState(nextState);
          writeCache(nextState);
        }
        return;
      }
      if (!api) {
        if (requestIsCurrent()) {
          const nextState: EventSettingsWorkspaceState = {
            status: "config-error",
            message: "The organizer API URL is not configured for event settings.",
          };
          setState(nextState);
          writeCache(nextState);
        }
        return;
      }
      setState((current) => (current.status === "loaded" ? current : { status: "loading" }));
      setEventIdentity(undefined);
      setNotice(null);
      let coreData: EventSettingsData | undefined;
      try {
        const [identity, loaded] = await Promise.all([
          api.getEventIdentity(eventId, signal),
          loadEventSettingsProgressively(
            api,
            organizationId,
            eventId,
            (core) => {
              if (!requestIsCurrent()) return;
              coreData = core;
              const nextState: EventSettingsWorkspaceState = {
                status: "loaded",
                data: core,
                detailsStatus: "loading",
              };
              setState(nextState);
              writeCache(nextState);
            },
            signal,
          ),
        ]);
        if (requestIsCurrent()) {
          const nextState: EventSettingsWorkspaceState = {
            status: "loaded",
            data: loaded,
            detailsStatus: "loaded",
          };
          setEventIdentity(identity);
          setState(nextState);
          writeCache(nextState, identity);
        }
      } catch (error) {
        if (!requestIsCurrent() || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        const preservedData = coreData ?? initialCachedData;
        if (preservedData !== undefined) {
          const nextState: EventSettingsWorkspaceState = {
            status: "loaded",
            data: preservedData,
            detailsStatus: "error",
            detailsMessage: messageFrom(error),
          };
          setState(nextState);
          writeCache(nextState);
        } else {
          const nextState: EventSettingsWorkspaceState = {
            status: "error",
            message: messageFrom(error),
          };
          setState(nextState);
          writeCache(nextState);
        }
      }
    },
    [
      api,
      cacheScope,
      eventId,
      initialCacheIdentity,
      initialCacheIdentityMatchesScope,
      initialCachedData,
      navigationCache,
      organizationId,
    ],
  );

  useEffect(() => {
    if (reuseInitialCache && navigationCache?.get(cacheScope) === initialCacheSnapshot) {
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [cacheScope, initialCacheSnapshot, load, navigationCache, reuseInitialCache]);

  const currentData = state.status === "loaded" ? state.data : null;

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = ++requestVersion.current;
    if (!api) throw new TypeError("The organizer API URL is not configured for event settings.");
    const loaded = await api.getOverview(eventId);
    if (
      canCommitEventSettingsAsyncCompletion(requestId, requestVersion.current, mountedRef.current)
    ) {
      const nextState: EventSettingsWorkspaceState = {
        status: "loaded",
        data: normalizeData(loaded, organizationId, eventId),
        detailsStatus: "loaded",
      };
      const refreshedIdentity =
        eventIdentity ?? (initialCacheIdentityMatchesScope ? initialCacheIdentity : undefined);
      setState(nextState);
      navigationCache?.set(cacheScope, {
        state: nextState,
        ...(refreshedIdentity === undefined ? {} : { eventIdentity: refreshedIdentity }),
      });
    }
  }, [
    api,
    cacheScope,
    eventId,
    eventIdentity,
    initialCacheIdentity,
    initialCacheIdentityMatchesScope,
    navigationCache,
    organizationId,
  ]);

  async function mutate(
    operation: () => Promise<void>,
    successMessage: string,
    invalidateAgendaCatalog = false,
  ): Promise<void> {
    if (!currentData || !mountedRef.current) return;
    navigationCache?.invalidate(cacheScope);
    if (!api) {
      const error = new TypeError("The organizer API URL is not configured for event settings.");
      setNotice(`Unable to complete this change. ${error.message}`);
      throw error;
    }
    requestVersion.current += 1;
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      if (invalidateAgendaCatalog) {
        invalidateAgendaCatalogAfterEventSettingsMutation(agendaNavigationCache, eventId);
      }
      let outcome: "refreshed" | "refresh-failed";
      try {
        await refresh();
        outcome = "refreshed";
      } catch {
        outcome = "refresh-failed";
      }
      if (!mountedRef.current) return;
      setNotice(
        outcome === "refreshed"
          ? successMessage
          : `${successMessage} The saved change could not be refreshed; reload to see the latest settings.`,
      );
    } catch (error) {
      if (!mountedRef.current) throw error;
      const message =
        error instanceof EventSettingsApiError && error.code === "VERSION_CONFLICT"
          ? "This event settings record changed in another organizer session. Reload before saving again."
          : messageFrom(error);
      try {
        await refresh();
      } catch {
        // Keep the loaded state and original mutation error when the recovery read is unavailable.
      }
      if (mountedRef.current) setNotice(`Unable to complete this change. ${message}`);
      throw error;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const actions = createEventSettingsWorkspaceActions(api, eventId, mutate);

  return (
    <EventSettingsWorkspaceView
      organizationId={organizationId}
      eventId={eventId}
      {...(eventIdentity === undefined ? {} : { eventIdentity })}
      section={section}
      state={state}
      busy={busy}
      notice={notice}
      actions={actions}
      onRetry={() => void load()}
    />
  );
}
