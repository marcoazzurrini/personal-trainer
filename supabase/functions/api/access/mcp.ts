// The connector's protocol: one JSON-RPC message in, one answer out, and one
// tool. This is the whole of what the plugin's connector does, and it is
// deliberately not the API — the API stays HTTP and curl, steered by the
// coaching documents, because a tool schema per endpoint would cost the coach
// tens of thousands of tokens of context before a word of coaching. What a
// sign-in cannot do is put a secret in the coach's hands; this can, and that
// is its only job.
//
// Streamable HTTP, in the smallest form the specification allows: every
// message is its own POST, every request is answered with one JSON object,
// there is no session and no event stream. A client that opens a GET is told
// so with a 405, which the specification names as the answer of a server
// that offers no stream.
//
// Import-free, so the dispatch is tested in-process with a stub minter.

export const TOOL_NAME = "get_api_token";

// The versions this server has read the specification for. A client naming
// one of these is answered in kind; any other is answered with the latest,
// which is what the specification asks of a server meeting a version it does
// not know.
export const PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;
const LATEST_PROTOCOL_VERSION = "2025-06-18";

const TOOL_DESCRIPTION =
  "Mint a fresh token for Marco's coach API. Call it once, at the start of a conversation about training or eating. It returns token, base_url and expires_at: send the token as `Authorization: Bearer <token>` on every curl call against base_url. A 401 from the API later in the conversation means the token expired — call this again and retry the call.";

const INSTRUCTIONS =
  "This connector only signs the coach in. Everything else — reading the coaching documents, logging, planning — goes through the coach API with curl, using the token get_api_token returns.";

export interface McpDeps {
  issue(subject: string): Promise<{ token: string; expires_at: string }>;
  baseUrl: string;
  version: string;
}

export type McpOutcome =
  | { status: 200; body: unknown }
  | { status: 202 }
  | { status: 400; body: unknown };

type Message = Record<string, unknown>;

function record(value: unknown): Message | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Message // checked: the guard above
    : null;
}

function result(id: unknown, value: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value } };
}

function failure(
  id: unknown,
  code: number,
  message: string,
  status: 200 | 400 = 200,
): McpOutcome {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

export async function handleMcp(
  message: unknown,
  caller: { subject: string },
  deps: McpDeps,
): Promise<McpOutcome> {
  const m = record(message);
  if (m === null || m.jsonrpc !== "2.0") {
    return failure(
      null,
      -32600,
      'The body must be one JSON-RPC 2.0 message: an object with "jsonrpc": "2.0". Batches are not accepted.',
      400,
    );
  }

  // A notification has no id, and a response has a result or an error. This
  // server sends no requests, so it expects no responses, and it acts on no
  // notification — but both are accepted, because the specification says a
  // server accepts them with a 202 and no body, and the client sends
  // notifications/initialized before its first real request.
  if (!("id" in m) || "result" in m || "error" in m) return { status: 202 };

  const id = m.id;
  const params = record(m.params) ?? {};
  switch (m.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = typeof asked === "string" &&
          (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "personal-trainer", version: deps.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: [{
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          inputSchema: { type: "object", properties: {} },
        }],
      });
    case "tools/call": {
      if (params.name !== TOOL_NAME) {
        return failure(
          id,
          -32602,
          `No tool named "${
            String(params.name)
          }". The only tool is ${TOOL_NAME}.`,
        );
      }
      const minted = await deps.issue(caller.subject);
      return result(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            token: minted.token,
            base_url: deps.baseUrl,
            expires_at: minted.expires_at,
          }),
        }],
      });
    }
    default:
      return failure(
        id,
        -32601,
        `No method "${
          String(m.method)
        }". This server answers initialize, ping, tools/list and tools/call.`,
      );
  }
}

// --- The origin the outside world sees ---------------------------------------

// The function sits behind a gateway that ends TLS, so the request it sees
// says http where every caller said https. The scheme the outside world used
// is what a discovery document must carry, or a client is sent to an address
// that does not exist. The gateway's own word (x-forwarded-proto) wins; with
// no word, https is assumed for any host that is not the local stack, whose
// addresses really are plain http.
const LOCAL_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "kong",
  "host.docker.internal",
]);

export function publicOrigin(seen: {
  protocol: string;
  hostname: string;
  host: string;
  forwardedProto: string | null;
}): string {
  const scheme = seen.forwardedProto?.split(",")[0].trim() ||
    (LOCAL_HOSTS.has(seen.hostname)
      ? seen.protocol.replace(/:$/, "")
      : "https");
  return `${scheme}://${seen.host}`;
}

// --- Telling a client where to sign in ---------------------------------------

// The protected resource metadata (RFC 9728): the one document a client reads
// before it knows anything, naming the authorization server to sign in with.
// The specification has clients look for it at a well-known path on the
// host's root, which on supabase.co is not ours to serve; so the 401 below
// says exactly where it is instead, which the specification also provides
// for. Three fields and no scopes: the authorization server hosts its own
// consent screen and the token carries no email, so there is nothing to ask
// the person for beyond the sign-in itself.
export function protectedResourceMetadata(
  resource: string,
  issuer: string,
): {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
} {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  };
}

// The challenge on a 401. Bare when no credential came at all — RFC 6750
// says to send no error code in that case — and error="invalid_token" when
// one came and was refused, which is what tells a client to refresh its
// token rather than start the sign-in over. Some authorization servers'
// examples add error="unauthorized" with a description; that is not a
// registered code, and the one parameter a client acts on is
// resource_metadata. If a client ever fails to start the sign-in from this
// header, adding those two parameters is a change to this line alone.
export function challengeHeader(
  metadataUrl: string,
  invalidToken: boolean,
): string {
  const reason = invalidToken ? ', error="invalid_token"' : "";
  return `Bearer resource_metadata="${metadataUrl}"${reason}`;
}
