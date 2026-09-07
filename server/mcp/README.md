# AppScreen MCP

The server exposes the same workspace-scoped services used by the SaaS at `/mcp`, using the official SDK's stateless Streamable HTTP transport. Each request authenticates independently. Design and rendering jobs persist in the database; losing an MCP connection does not stop them.

## Connect a client

The examples below use a placeholder deployment URL. Use the actual HTTPS AppScreen host, or your local API address during development. Create a scoped AppScreen access token through the authenticated account UI/API. Store the token in the client's environment or credential store, never in a repository, prompt or screenshot. These instructions do not create or install credentials automatically.

### Codex

Add this to the appropriate Codex `config.toml`, with `APPSCREEN_MCP_TOKEN` supplied securely to the Codex host environment:

```toml
[mcp_servers.appscreen]
url = "https://your-appscreen-host.example/mcp"
bearer_token_env_var = "APPSCREEN_MCP_TOKEN"
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Restart the MCP connection and inspect `/mcp`. Configuration fields and bearer/OAuth support are documented in the [official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

### Claude Code

Use a private/local MCP configuration with an environment-variable reference, not a literal token:

```json
{
  "mcpServers": {
    "appscreen": {
      "type": "http",
      "url": "https://your-appscreen-host.example/mcp",
      "headers": { "Authorization": "Bearer ${APPSCREEN_MCP_TOKEN}" }
    }
  }
}
```

Provide that configuration through Claude Code's supported local configuration flow, supply `APPSCREEN_MCP_TOKEN` securely, then inspect `/mcp`. See [Claude Code's MCP reference](https://code.claude.com/docs/en/mcp) for HTTP transport and environment-variable expansion. Do not commit a generated configuration containing an expanded secret.

### OAuth status

Live OAuth remains disabled pending the launch gates in [SAAS_SETUP.md](../../SAAS_SETUP.md#mcp-connections-and-native-oauth). The native Supabase adapter is implemented: Supabase owns client registration, PKCE/code exchange and refresh tokens; AppScreen owns explicit workspace permissions, expiring versioned grants, and immediate local revocation. It does not operate a custom password, code or refresh-token server. The protected-resource metadata advertises the configured Supabase authorization server only when OAuth is enabled. [Supabase OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started), [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

This integration requires asymmetric Supabase JWT signing and its public JWKS endpoint. Legacy HS256-only projects are unsupported by the server's JWKS verifier; do not supply a shared JWT signing secret as a workaround. Real-provider tests must prove that an OAuth token cannot mutate the underlying Supabase Auth account, not just that AppScreen denies owner endpoints. Local signed-JWT and mocked-provider tests do not establish that boundary. Bearer tokens remain an independent fallback.

After those gates pass, configure the same HTTP endpoint without a bearer authorization override and start the client's OAuth login. Codex supports `codex mcp login appscreen` and the desktop Authenticate action; bearer credentials take precedence if still configured. Verify the exact callback and registration method used by the installed client rather than assuming a callback URL. [Official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp)

### Explicit reconnect behavior

Supabase can reuse earlier consent and return only a callback URL, without client identity. AppScreen discards that callback/code: it cannot use it to identify or renew a local grant. Even a still-valid connection is not silently extended. The consent page asks the owner to select exactly one known connection, explicitly clear its earlier approval, and restart authorization from the agent. Missing client names display as “Unnamed client”; a name is not a verified publisher identity.

The browser-only reset is `POST /api/connections/:id/reconnect` with `{expectedVersion, confirmation:"reconnect"}`. It immediately revokes local access, then removes only that client’s upstream approval. It does not change scopes or expiry, and does not grant new access. A fresh consent decision is required after restarting. If the provider is unavailable, `upstreamRevocationPending` is true and `reconnectReady` is false; retry with the response's new `version`, or reload current connection details first. A stale version returns `OAUTH_CONNECTION_CHANGED`; concurrent handoff returns `OAUTH_CONNECTION_BUSY`. No reconnect operation revokes every client. If no known local connection exists, an operator must resolve that specific provider approval, or the user can choose a scoped token.

## Two design modes

**External designer:** Codex or Claude makes decisions and calls direct tools. No hosted AppScreen model call is made. Storage/rendering quotas still apply.

1. List/create a project, then request an upload for each real screenshot.
2. Upload actual bytes to the returned short-lived destination using its method and headers. A remote server cannot open a local file path.
3. Complete each upload, list templates and inspect a template preview. Select only a returned template with `cloudCompatible: true`; both list and detail include `cloudLimitations` for local-editor-only features. Presence in the catalog alone is not cloud compatibility.
4. Create a draft from verified asset IDs and the selected template. This supplies stable scene/device/source IDs.
5. Read the operation reference, apply document edits against the expected base revision, and render a preview job.
6. Poll the job with backoff, retrieve fresh result links, inspect the previews, and apply further edits if needed.
7. Export an immutable revision. Apply a reviewed draft only with the user's approval and the current expected revision.

**Hosted designer:** the client starts `appscreen_create_design_job` or `appscreen_create_revision_job`. The user must authorize the quoted `maxCredits`; the service reserves credits transactionally. The tool returns a job ID promptly. Poll the job and retrieve the editable draft and exports. Automatic repairs and retries do not create a second user charge.

The input revision is mandatory for hosted tools; first create a draft if starting from newly uploaded assets. Exact template mode keeps positions. Inspiration allows constrained layout changes. Both respect locks. Hosted generation does not publish to an app store or replace original screenshot pixels.

Unsupported explicit templates fail before new job/credit admission. Automatic selection ignores a retained template ID. Unsupported saved composition checkpoints also block retry before credit re-reservation; start a new compatible draft instead of repeatedly retrying the same immutable design. Existing accepted request keys continue to retrieve their original job, not to authorize different work. These rules are exercised by local API/MCP fixtures, not yet by actual connected Codex/Claude clients.

## Permissions

| Scope | Tools |
| --- | --- |
| `projects:read` | Project/template reads, operation reference, job status, signed result links |
| `projects:write` | Create drafts/projects, edit/apply revisions, cancel/retry owned jobs |
| `assets:write` | Request and complete owned screenshot uploads |
| `exports:write` | Preview/render/export jobs without hosted AI |
| `ai:run` | Hosted design and natural-language refinement jobs |

The services layer must independently verify tenant/resource ownership, active membership, current scopes, expected revisions, quotas and billing. A retry of an AI job must recheck `ai:run` even though the generic retry tool also requires project-write permission. Do not offer billing administration, shell, SQL, arbitrary URL imports, filesystem access or publication tools.

## Host integration

`registerMcp(app, services, authenticate, { baseUrl, allowedOrigins, authorizationServers })` registers the routes. `authenticate(request)` returns `{ userId, workspaceId, role, scopes, authKind }`. Only one workspace is authorized per token/context; tool arguments cannot select a different tenant.

Service methods receive `(context, args)`:

`listProjects`, `createProject`, `getProject`, `requestAssetUpload`, `completeAssetUpload`, `listTemplates`, `getTemplate`, `createDraft`, `applyOperations`, `applyRevision`, `createJob`, `getJob`, `cancelJob`, `retryJob`, `getResult`.

Writes include idempotency keys except cancel/upload completion, which are intrinsically idempotent. The host stores idempotency receipts; MCP annotations alone do not implement deduplication. The direct-edit contract is discoverable through `appscreen_get_operation_reference`.

Allowed origins are explicit. CLI requests without an Origin header are allowed after authentication; unrecognized browser origins return 403. GET and DELETE return 405 because this implementation does not maintain SSE sessions. JSON POST requests and protocol notifications use the SDK implementation. See [Streamable HTTP security requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Verification

`node --test server/mcp/*.test.mjs` exercises actual SDK tool discovery/calls over in-memory transport, Fastify HTTP initialization/discovery, authentication, scope denial, origin rejection, missing local-file access, direct/hosted separation and error redaction. These tests do not prove deployment connectivity or completed OAuth consent in either client. Run those against the intended host before launch.

Dedicated-database tests in `server/tests/oauth*.test.ts` cover signed-token audience/scope/owner separation, consent, immediate capability revocation, unnamed DCR clients, expired/revoked grants, explicit reconnect, provider failure retry and concurrent version fencing. They use generated keys and an isolated provider fixture, never a real Supabase account. Record separate actual-provider results for Codex and Claude discovery, PKCE, refresh, denial, reconnect and revocation before describing OAuth as launch-ready.
