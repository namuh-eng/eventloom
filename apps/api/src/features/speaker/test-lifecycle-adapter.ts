import type {
  SpeakerOrganizerLifecycleRepository,
  SpeakerOrganizerReadModel,
  SpeakerProfile,
  SpeakerRepository,
  SpeakerRosterEntry,
} from "./types";

type TestSpeakerStore = SpeakerRepository & {
  readonly organizerScopes?: ReadonlyMap<string, SpeakerOrganizerReadModel["scope"]>;
  readonly submissions?: SpeakerOrganizerReadModel["submissions"];
  readonly roster?: SpeakerRosterEntry[];
  readonly profiles?: SpeakerProfile[];
  readonly tasks?: SpeakerOrganizerReadModel["tasks"];
  readonly assets?: SpeakerOrganizerReadModel["assets"];
};

type ImportPreview = Awaited<
  ReturnType<SpeakerOrganizerLifecycleRepository["saveOrganizerSpeakerImportPreview"]>
>;

const previews = new WeakMap<object, Map<string, ImportPreview>>();
const operations = new WeakMap<object, Map<string, { digest: string; participantId: string }>>();

function mutableArray<T>(value: readonly T[] | undefined, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`The test speaker repository has no ${label} store.`);
  return value as T[];
}

/** Test-only compatibility adapter. Production composition requires the canonical D1 lifecycle. */
export function withTestSpeakerOrganizerLifecycle<T extends SpeakerRepository>(
  repository: T,
): T & SpeakerOrganizerLifecycleRepository {
  const existing = repository as T & Partial<SpeakerOrganizerLifecycleRepository>;
  const previewStore = previews.get(repository) ?? new Map<string, ImportPreview>();
  previews.set(repository, previewStore);
  const operationStore = operations.get(repository) ?? new Map();
  operations.set(repository, operationStore);

  const lifecycle: SpeakerOrganizerLifecycleRepository = {
    getOrganizerAccessScope(eventId, accountId) {
      if (existing.getOrganizerAccessScope !== undefined) {
        return existing.getOrganizerAccessScope.call(repository, eventId, accountId);
      }
      return Promise.resolve(null);
    },
    async getOrganizerReadModel(eventId, accountId, resources) {
      if (existing.getOrganizerReadModel !== undefined) {
        return existing.getOrganizerReadModel.call(repository, eventId, accountId, resources);
      }
      const scope = await lifecycle.getOrganizerAccessScope(eventId, accountId);
      if (scope === null) return null;
      const store = repository as TestSpeakerStore;
      return {
        scope,
        submissions: (store.submissions ?? []).filter(
          (submission) => submission.eventId === eventId,
        ),
        roster: (store.roster ?? []).filter((entry) => entry.eventId === eventId),
        profiles:
          resources.profiles === true
            ? (store.profiles ?? []).filter((profile) => profile.eventId === eventId)
            : [],
        tasks:
          resources.tasks === true
            ? (store.tasks ?? []).filter((task) => task.eventId === eventId)
            : [],
        assets:
          resources.assets === true
            ? (store.assets ?? []).filter((asset) => asset.eventId === eventId)
            : [],
        canonicalSessions: [],
      };
    },
    resolveEventParticipant(input) {
      if (existing.resolveEventParticipant !== undefined) {
        return existing.resolveEventParticipant.call(repository, input);
      }
      const store = repository as TestSpeakerStore;
      const normalizedEmail = input.normalizedEmail?.trim().toLowerCase();
      const matches = (store.profiles ?? []).filter(
        (profile) =>
          profile.eventId === input.eventId &&
          (profile.participantId === input.explicitParticipantId ||
            (profile.sourceType === input.sourceType && profile.sourceId === input.sourceId) ||
            (normalizedEmail !== undefined &&
              profile.email?.trim().toLowerCase() === normalizedEmail)),
      );
      if (matches.length > 1) {
        return Promise.resolve({
          state: "ambiguous",
          candidateParticipantIds: matches.map((profile) => profile.participantId),
        });
      }
      const participantId = matches[0]?.participantId ?? input.createParticipantId;
      return Promise.resolve({
        state: "resolved",
        participantId,
        submissionIds: (store.submissions ?? [])
          .filter(
            (submission) =>
              submission.eventId === input.eventId &&
              submission.participantIds.includes(participantId),
          )
          .map((submission) => submission.id),
        created: matches.length === 0,
      });
    },
    saveOrganizerSpeakerImportPreview(command) {
      const preview: ImportPreview = {
        previewId: command.previewId,
        sourceDigest: command.sourceDigest,
        rosterRevision: (repository as TestSpeakerStore).profiles?.length ?? 0,
        validRows: structuredClone(command.rows),
        invalidRows: [],
      };
      previewStore.set(command.previewId, structuredClone(preview));
      return Promise.resolve(preview);
    },
    async commitOrganizerSpeakerImport(command) {
      const preview = previewStore.get(command.previewId);
      if (
        preview === undefined ||
        (command.sourceDigest !== undefined && preview.sourceDigest !== command.sourceDigest)
      ) {
        throw new Error("The speaker import preview is invalid.");
      }
      const participantIds: string[] = [];
      for (const row of preview.validRows) {
        const participantId = `participant:${command.previewId}:${row.rowNumber}`;
        participantIds.push(participantId);
        const result = await lifecycle.upsertOrganizerSpeakerAggregate({
          organizationId: command.organizationId,
          eventId: command.eventId,
          accountId: command.accountId,
          participantId,
          profileId: `profile:${command.eventId}:${participantId}`,
          displayName: row.displayName,
          email: row.email,
          jobTitle: row.jobTitle,
          company: row.company,
          biography: row.biography,
          socialLinks: row.socialLinks,
          travelLogistics: {
            travelRequired: false,
            arrivalAt: null,
            departureAt: null,
            accommodation: "",
            dietaryRequirements: "",
            accessibilityNeeds: "",
            travelNotes: "",
          },
          status: row.status ?? "pending",
          sourceType: "csv",
          sourceId: `${command.previewId}:row:${row.rowNumber}`,
          expectedVersion: null,
          idempotencyKey: `${command.idempotencyKey}:row:${row.rowNumber}`,
          ...(preview.sourceDigest === undefined ? {} : { sourceDigest: preview.sourceDigest }),
          updatedAt: command.committedAt,
        });
        if (!result.ok) throw new Error("The speaker import could not be committed.");
      }
      return { participantIds, replayed: false };
    },
    upsertOrganizerSpeakerAggregate(command) {
      const store = repository as TestSpeakerStore;
      const profilesStore = mutableArray(store.profiles, "profile");
      const rosterStore = mutableArray(store.roster, "roster");
      const operationKey =
        command.idempotencyKey === undefined
          ? undefined
          : `${command.eventId}:${command.idempotencyKey}`;
      const digest = command.sourceDigest ?? "";
      const replay = operationKey === undefined ? undefined : operationStore.get(operationKey);
      if (replay !== undefined) {
        if (replay.digest !== digest || replay.participantId !== command.participantId) {
          return Promise.resolve({ ok: false, reason: "version_conflict" });
        }
        const profile = profilesStore.find(
          (candidate) =>
            candidate.eventId === command.eventId &&
            candidate.participantId === command.participantId,
        );
        return Promise.resolve(
          profile === undefined
            ? { ok: false, reason: "not_found" }
            : { ok: true, value: structuredClone(profile) },
        );
      }
      const profileIndex = profilesStore.findIndex(
        (profile) =>
          profile.eventId === command.eventId && profile.participantId === command.participantId,
      );
      const current = profilesStore[profileIndex];
      if (
        command.expectedVersion === null
          ? current !== undefined
          : current?.version !== command.expectedVersion
      ) {
        return Promise.resolve({ ok: false, reason: "version_conflict" });
      }
      const profile: SpeakerProfile = {
        id: current?.id ?? command.profileId,
        eventId: command.eventId,
        participantId: command.participantId,
        displayName: command.displayName,
        email: command.email,
        jobTitle: command.jobTitle,
        company: command.company,
        biography: command.biography,
        socialLinks: structuredClone(command.socialLinks),
        travelLogistics: structuredClone(command.travelLogistics),
        status: command.status,
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        version: (current?.version ?? 0) + 1,
        updatedAt: command.updatedAt,
      };
      if (profileIndex < 0) profilesStore.push(profile);
      else profilesStore[profileIndex] = profile;
      const submissionId = (store.submissions ?? []).find(
        (submission) =>
          submission.eventId === command.eventId &&
          submission.participantIds.includes(command.participantId),
      )?.id;
      const rosterIndex = rosterStore.findIndex(
        (entry) =>
          entry.eventId === command.eventId && entry.participantId === command.participantId,
      );
      const rosterEntry: SpeakerRosterEntry = {
        id: profile.id,
        eventId: command.eventId,
        ...(submissionId === undefined ? {} : { submissionId }),
        participantId: command.participantId,
        displayName: command.displayName,
        email: command.email,
        jobTitle: command.jobTitle,
        company: command.company,
        biography: command.biography,
        socialLinks: structuredClone(command.socialLinks),
        travelLogistics: structuredClone(command.travelLogistics),
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        role: "primary",
        status:
          command.status === "revoked"
            ? "revoked"
            : command.status === "active"
              ? "active"
              : "pending",
        workflowStatus: command.status,
        organizerStatus: command.status,
        version: profile.version,
        createdAt: current?.updatedAt ?? command.updatedAt,
        updatedAt: command.updatedAt,
        authorAccountId: command.accountId,
      };
      if (rosterIndex < 0) rosterStore.push(rosterEntry);
      else rosterStore[rosterIndex] = rosterEntry;
      if (operationKey !== undefined) {
        operationStore.set(operationKey, { digest, participantId: command.participantId });
      }
      return Promise.resolve({ ok: true, value: structuredClone(profile) });
    },
  };

  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property in lifecycle) {
        return lifecycle[property as keyof SpeakerOrganizerLifecycleRepository];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T & SpeakerOrganizerLifecycleRepository;
}
