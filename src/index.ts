import "./nodeRuntime.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CONFIG_FILE, loadConfig, type ServerConfig, VERSION } from "./config.js";
import { GraphQLClient } from "./graphqlClient.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerDocTools } from "./tools/docs.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerUserTools } from "./tools/user.js";
import { registerUserCRUDTools } from "./tools/userCRUD.js";
import { registerBlobTools } from "./tools/blobStorage.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { AuthSession, parseLoginMode, type AuthSnapshot } from "./authSession.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerIconTools } from "./tools/icons.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { runCli } from "./cli.js";
import { startHttpMcpServer } from "./sse.js";
import { existsSync } from "fs";
import { createToolFilter, toolAnnotationsFor } from "./toolSurface.js";
import { toolOutputSchemaFor } from "./toolOutputSchemas.js";
import { coordinateTool } from "./toolCoordination.js";
import { stripSchemaDialect, withToolErrors } from "./util/mcp.js";
import { resolveConfiguredAuth } from "./util/configuredAuth.js";
import {
  assertOAuthServiceWritePolicy,
  createToolFilterEnvironment,
} from "./oauthServicePolicy.js";
import { DelegatedAffineAuth, runWithDelegatedAuth } from "./delegatedAuth.js";

// CLI commands: affine-mcp login|status|logout|version
const rawArgs = process.argv.slice(2);
const cliArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const subcommand = cliArgs[0];
if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (subcommand === "--help" || subcommand === "-h") {
  await runCli("help");
  process.exit(0);
}
if (subcommand) {
  const handled = await runCli(subcommand, cliArgs.slice(1));
  if (!handled) {
    console.error(`Unknown command: ${subcommand}`);
    await runCli("help");
    process.exit(1);
  }
  process.exit(0);
}

// MCP server mode (default)
function loadServerConfig(): ServerConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[affine-mcp] Invalid configuration: ${message}`);
    process.exit(1);
  }
}
const config = loadServerConfig();
const useHttpTransport = config.transportMode === "http";
const usesDelegatedAuth = config.backendAuthMode === "oauth_token_exchange";

// Shared-credential OAuth deployments default to read-only. Delegated OAuth
// exchanges each caller's token for their own short-lived AFFiNE credential.
const toolFilterEnvironment = createToolFilterEnvironment(config.authMode, process.env);

// Tool filtering is parsed once at module load (not per-session in HTTP mode).
const toolFilter = createToolFilter(toolFilterEnvironment);

if (config.authMode === "oauth" && !useHttpTransport) {
  throw new Error("AFFINE_MCP_AUTH_MODE=oauth requires MCP_TRANSPORT=http (or streamable/sse).");
}
if (config.authMode === "oauth" && process.env.AFFINE_LOGIN_AT_START && !usesDelegatedAuth) {
  console.error("[affine-mcp] AFFINE_LOGIN_AT_START is ignored when AFFINE_MCP_AUTH_MODE=oauth.");
}

const loginMode = config.authMode === "oauth"
  ? "async"
  : parseLoginMode(process.env.AFFINE_LOGIN_AT_START);

const configuredAuth = resolveConfiguredAuth(config);
const sessionBearer = configuredAuth.apiToken;
const sessionCookie = configuredAuth.cookie;
let authSession: AuthSession | undefined;
let delegatedAuth: DelegatedAffineAuth | undefined;
let backendAuthProvider: () => Promise<AuthSnapshot>;

if (usesDelegatedAuth) {
  if (config.authMode !== "oauth" || !useHttpTransport) {
    throw new Error(
      "AFFINE_BACKEND_AUTH_MODE=oauth_token_exchange requires AFFINE_MCP_AUTH_MODE=oauth and MCP_TRANSPORT=http.",
    );
  }
  if (configuredAuth.kind !== "none") {
    throw new Error(
      "AFFINE_BACKEND_AUTH_MODE=oauth_token_exchange cannot be combined with AFFINE_API_TOKEN, " +
      "AFFINE_COOKIE, AFFINE_EMAIL, AFFINE_PASSWORD, or authentication headers.",
    );
  }
  delegatedAuth = new DelegatedAffineAuth({
    baseUrl: config.baseUrl,
    exchangePath: config.tokenExchangePath,
    exchangeUrl: config.tokenExchangeUrl,
    timeoutMs: config.tokenExchangeTimeoutMs,
    cacheMaxEntries: config.tokenExchangeCacheMaxEntries,
  });
  backendAuthProvider = () => delegatedAuth!.ready();
} else {
  authSession = new AuthSession({
    baseUrl: config.baseUrl,
    bearer: sessionBearer,
    cookie: sessionCookie,
    email: sessionBearer || sessionCookie ? undefined : configuredAuth.email,
    password: sessionBearer || sessionCookie ? undefined : configuredAuth.password,
    headers: configuredAuth.headers,
  });
  if (config.authMode === "oauth" && !authSession.hasConfiguredAuth) {
    throw new Error(
      "AFFINE_MCP_AUTH_MODE=oauth with configured backend auth requires AFFiNE service credentials. " +
      "Set AFFINE_EMAIL and AFFINE_PASSWORD, AFFINE_COOKIE, or a compatible AFFINE_API_TOKEN.",
    );
  }
  backendAuthProvider = () => authSession!.ready();
}

// The process-scoped AuthSession owns credentials after configuration is loaded.
config.email = undefined;
config.password = undefined;

if (loginMode === "async" && authSession?.requiresLogin) {
  authSession.start();
}

// Startup diagnostics (visible in Claude Code MCP server logs via stderr)
console.error(`[affine-mcp] Config: ${CONFIG_FILE} (${existsSync(CONFIG_FILE) ? 'found' : 'missing'})`);
console.error(`[affine-mcp] Endpoint: ${config.graphqlEndpoint}`);
const authSource = usesDelegatedAuth
  ? "oauth token exchange"
  : authSession?.hasConfiguredAuth ? authSession.source : "not configured";
console.error(`[affine-mcp] Auth: ${authSource}`);
if (authSource === "not configured") {
  console.error("[affine-mcp] WARNING: No authentication configured. Some operations may fail.");
  console.error("[affine-mcp] Set AFFINE_EMAIL and AFFINE_PASSWORD, AFFINE_COOKIE, or run: affine-mcp login");
}
console.error(`[affine-mcp] HTTP auth mode: ${config.authMode}`);

console.error(`[affine-mcp] Workspace: ${config.defaultWorkspaceId ? 'set' : '(none)'}`);

assertOAuthServiceWritePolicy({
  authMode: config.authMode,
  backendAuthMode: config.backendAuthMode,
  allowServiceWrites: config.oauthAllowServiceWrites,
  enabledWriteTools: toolFilter.enabledWriteTools,
});
if (
  config.authMode === "oauth"
  && !usesDelegatedAuth
  && config.oauthAllowServiceWrites
  && toolFilter.enabledWriteTools.length > 0
) {
  console.error(
    "[affine-mcp] WARNING: OAuth service-account writes are enabled. Every authorized OAuth caller " +
    "can mutate AFFiNE with the shared backend service identity permissions.",
  );
}

async function buildServer() {
  const server = new McpServer(
    { name: "affine-mcp", version: VERSION },
    { maxToolInputElements: 20_000 },
  );
  const gqlHeaders = { ...(config.headers || {}) };

  // Initialize GraphQL client with authentication
  const gql = new GraphQLClient({
    endpoint: config.graphqlEndpoint,
    baseUrl: config.baseUrl,
    headers: gqlHeaders,
    authProvider: backendAuthProvider,
  });


  const originalRegisterTool = (server as any).registerTool?.bind(server);
  if (typeof originalRegisterTool !== "function") {
    const message =
      "[affine-mcp] server.registerTool not found - tool filtering cannot be enforced. " +
      "The MCP SDK API may have changed.";
    throw new Error(`${message} Refusing to start because the canonical tool surface cannot be enforced.`);
  } else {
    (server as any).registerTool = (name: string, options: any, handler: any) => {
      if (!toolFilter.isEnabled(name)) return;
      const outputSchema = options?.outputSchema ?? toolOutputSchemaFor(name);
      const coordinated = coordinateTool(name, options?.inputSchema || {}, handler, {
        gql, endpoint: config.graphqlEndpoint, workspaceId: config.defaultWorkspaceId,
      });
      const contextualHandler = (...args: any[]) => {
        const invoke = coordinated.handler as (...handlerArgs: any[]) => any;
        if (!usesDelegatedAuth) return invoke(...args);
        const extra = args[args.length - 1];
        return runWithDelegatedAuth(extra?.authInfo, () => invoke(...args));
      };
      return originalRegisterTool(name, {
        ...options,
        inputSchema: coordinated.inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: {
          ...toolAnnotationsFor(name),
          ...(options?.annotations || {}),
        },
      }, withToolErrors(contextualHandler, {
        toolName: name,
        authMode: config.authMode,
        backendAuthMode: config.backendAuthMode,
        readOnly: Boolean(toolAnnotationsFor(name).readOnlyHint),
      }));
    };
  }
  console.error(`[affine-mcp] Tool profile: ${toolFilter.profile}`);
  console.error(`[affine-mcp] Disabled groups: ${toolFilterEnvironment.AFFINE_DISABLED_GROUPS || "(none)"}`);
  console.error(`[affine-mcp] Disabled tools: ${toolFilterEnvironment.AFFINE_DISABLED_TOOLS || "(none)"}`);
  console.error(`[affine-mcp] Enabled tools: ${toolFilter.enabledTools.length}/${toolFilter.totalToolCount}`);

  registerWorkspaceTools(server, gql);
  registerDocTools(server, gql, {
    workspaceId: config.defaultWorkspaceId,
    toolSurface: { profile: toolFilter.profile, enabledTools: toolFilter.enabledTools },
  });
  registerCommentTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerHistoryTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerOrganizeTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerPropertyTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerIconTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerUserTools(server, gql);
  registerCanvasTools(server, gql, usesDelegatedAuth && process.env.AFFINE_CANVAS_RENDER_ENABLED === "true");
  registerUserCRUDTools(server, gql);
  if (config.authMode !== "oauth") {
    registerAuthTools(server, gql, config.baseUrl);
  }
  registerBlobTools(server, gql, undefined, { workspaceId: config.defaultWorkspaceId });
  registerNotificationTools(server, gql);
  stripSchemaDialect(server);
  return server;
}

async function start() {
  if (loginMode === "sync" && authSession?.requiresLogin) {
    await authSession.ready();
  }

  if (useHttpTransport) {
    await startHttpMcpServer(buildServer, config);
  } else {
    // stdio transport is the default for typical desktop MCP clients
    const server = await buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK's stdio transport listens for data but does not close itself on
    // EOF. Remote launchers such as `ssh ... docker exec -i` rely on EOF to
    // release the per-client process, so close the server explicitly.
    let shutdown: Promise<void> | undefined;
    const closeOnInputEnd = () => {
      if (!shutdown) {
        shutdown = server.close().catch((error) => {
          console.error("[affine-mcp] Failed to close stdio server:", error);
        });
      }
      return shutdown;
    };
    process.stdin.once("end", closeOnInputEnd);
    process.stdin.once("close", closeOnInputEnd);
  }
}

start().catch((err) => {
  console.error("Failed to start affine-mcp server:", err);
  process.exit(1);
});
