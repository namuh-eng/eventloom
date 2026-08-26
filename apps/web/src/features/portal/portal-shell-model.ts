import type { PortalCapability } from "./types";

export type PortalSignOutFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function signOutAndRedirect({
  fetcher = globalThis.fetch,
  navigate = (path) => window.location.assign(path),
}: Readonly<{
  fetcher?: PortalSignOutFetcher;
  navigate?: (path: string) => void;
}> = {}): Promise<boolean> {
  const response = await fetcher("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => null);
  if (response === null || !response.ok) return false;
  navigate("/login");
  return true;
}

export function portalRouteAuthorized(input: {
  readonly pathname: string;
  readonly workspace: string | null;
  readonly submissionCount: number;
  readonly can: (capability: PortalCapability) => boolean;
}): boolean {
  const { pathname, workspace, can } = input;
  if (pathname === "/portal" && workspace === null) return true;
  if (pathname.startsWith("/portal/submissions")) return true;
  if (pathname === "/portal/tasks" || workspace === "tasks") return can("task-response");
  if (pathname === "/portal/profile") return can("profile-self");
  if (workspace === "co-speakers") return can("profile-self");
  if (workspace === "files") return can("asset-read");
  if (workspace === "resources" || workspace === "wiki") return can("resource-read");
  return true;
}

export function portalContentMode(input: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasView: boolean;
  readonly routeAuthorized: boolean;
}): "children" | "no-access" {
  if (input.loading || (input.error !== null && !input.hasView)) return "children";
  return input.routeAuthorized ? "children" : "no-access";
}
