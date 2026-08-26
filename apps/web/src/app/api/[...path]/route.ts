import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

interface ApiProxyContext {
  params: Promise<{ path: string[] }>;
}
const API_PROXY_DEADLINE_MS = 15_000;
const CAPABILITY_UPLOAD_DEADLINE_MS = 5 * 60_000;

function proxyDeadlineMs(method: string, path: readonly string[]): number {
  return method === "PUT" &&
    path.length === 6 &&
    path[0] === "speaker" &&
    path[1] === "assets" &&
    path[2] === "capabilities" &&
    path[3] === "upload"
    ? CAPABILITY_UPLOAD_DEADLINE_MS
    : API_PROXY_DEADLINE_MS;
}

function gatewayTimeout(request: NextRequest): Response {
  return Response.json(
    {
      error: {
        code: "INTEGRATION_UNAVAILABLE",
        message: "The upstream API did not respond before the gateway deadline.",
        traceId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      },
    },
    {
      status: 504,
      headers: { "cache-control": "no-store" },
    },
  );
}

function relayBody(
  body: ReadableStream<Uint8Array>,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}

function upstreamOrigin(): string {
  const value = process.env.API_UPSTREAM_ORIGIN?.trim();
  if (!value) {
    throw new Error("API_UPSTREAM_ORIGIN is required for the web API transport.");
  }
  const parsed = new URL(value);
  const localHttp =
    parsed.protocol === "http:" &&
    process.env.APP_ENV === "local" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.origin !== value) {
    throw new Error(
      "API_UPSTREAM_ORIGIN must be an HTTPS origin (plain HTTP is allowed only for loopback hosts when APP_ENV=local).",
    );
  }
  return parsed.origin;
}
function browserRequestOrigin(request: NextRequest): URL {
  const suppliedOrigin = request.headers.get("origin")?.trim();
  if (suppliedOrigin && suppliedOrigin !== "null") {
    try {
      const parsed = new URL(suppliedOrigin);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.origin === suppliedOrigin
      ) {
        return parsed;
      }
    } catch {
      // Fall through to the request authority.
    }
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim() || request.nextUrl.host;
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? `${forwardedProtocol}:`
      : request.nextUrl.protocol;
  return new URL(`${protocol}//${host}`);
}

async function proxy(request: NextRequest, context: ApiProxyContext): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, upstreamOrigin());
  target.search = request.nextUrl.search;

  const browserOrigin = browserRequestOrigin(request);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-forwarded-host", browserOrigin.host);
  headers.set("x-forwarded-proto", browserOrigin.protocol.slice(0, -1));
  headers.set("origin", browserOrigin.origin);

  const upstreamController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      upstreamController.abort(
        new DOMException("The upstream API request timed out.", "TimeoutError"),
      );
    },
    proxyDeadlineMs(request.method, path),
  );
  const abortUpstream = (): void => {
    clearTimeout(timeout);
    upstreamController.abort(request.signal.reason);
  };
  if (request.signal.aborted) {
    abortUpstream();
  } else {
    request.signal.addEventListener("abort", abortUpstream, { once: true });
  }
  const cleanup = (): void => {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortUpstream);
  };

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const retryableRead = request.method === "GET" || request.method === "HEAD";
  let upstream: Response | undefined;
  let attempt = 0;
  while (upstream === undefined) {
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: upstreamController.signal,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      });
    } catch (error) {
      if (retryableRead && attempt === 0 && !timedOut && !upstreamController.signal.aborted) {
        attempt += 1;
        continue;
      }
      cleanup();
      if (timedOut) {
        return gatewayTimeout(request);
      }
      throw error;
    }
  }

  const responseHeaders = new Headers(upstream.headers);
  // The runtime already decompressed upstream.body; forwarding the original
  // framing headers would make the browser decode a plain body again.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("cache-control", "no-store");
  const body = upstream.body;
  if (body === null) cleanup();
  return new Response(body === null ? null : relayBody(body, cleanup), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
