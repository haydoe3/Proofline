import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

const PORT = Number(process.env.PORT) || 3000;
const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
const GRANOLA_PROTECTED_RESOURCE_URL =
  "https://mcp.granola.ai/.well-known/oauth-protected-resource";
const GRANOLA_AUTH_METADATA_URL =
  "https://mcp.granola.ai/.well-known/oauth-authorization-server";
const SESSION_COOKIE_NAME = "granola_mcp_session";
const MCP_PROTOCOL_VERSION = "2025-03-26";

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

interface PendingAuthState {
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  tokenEndpoint: string;
  createdAt: number;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface GranolaSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenEndpoint: string;
  mcpSessionId: string | null;
  tools: McpTool[] | null;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

let cachedAuthMetadata: OAuthMetadata | null = null;
let cachedResourceMetadata: ProtectedResourceMetadata | null = null;
const registeredClients = new Map<string, RegisteredClient>();
const pendingStates = new Map<string, PendingAuthState>();
const sessions = new Map<string, GranolaSession>();

let rpcIdCounter = 1;

function nextRpcId(): number {
  rpcIdCounter += 1;
  return rpcIdCounter;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

function getSessionFromRequest(req: Request): GranolaSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

function resolveBaseAppUrl(requestedOrigin?: string): string {
  if (requestedOrigin) {
    const trimmed = requestedOrigin.replace(/\/$/, "");
    if (
      /^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.run\.app$/i.test(trimmed) ||
      /^https:\/\/[a-z0-9-]+\.run\.app$/i.test(trimmed) ||
      /^http:\/\/localhost:\d+$/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, "");
  }
  return `http://localhost:${PORT}`;
}

async function discoverGranolaOAuth(): Promise<{
  auth: OAuthMetadata;
  resource: ProtectedResourceMetadata;
}> {
  if (!cachedResourceMetadata) {
    const res = await fetch(GRANOLA_PROTECTED_RESOURCE_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch Granola protected resource metadata (${res.status})`
      );
    }
    cachedResourceMetadata = (await res.json()) as ProtectedResourceMetadata;
  }

  if (!cachedAuthMetadata) {
    const res = await fetch(GRANOLA_AUTH_METADATA_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch Granola OAuth server metadata (${res.status})`
      );
    }
    cachedAuthMetadata = (await res.json()) as OAuthMetadata;
  }

  return { auth: cachedAuthMetadata, resource: cachedResourceMetadata };
}

async function getOrRegisterClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<RegisteredClient> {
  const existing = registeredClients.get(redirectUri);
  if (existing) return existing;

  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Granola x Gemini GTM Workspace",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Dynamic client registration failed (${res.status}): ${errText}`
    );
  }

  const client = (await res.json()) as RegisteredClient;
  registeredClients.set(redirectUri, client);
  return client;
}

async function ensureValidAccessToken(session: GranolaSession): Promise<void> {
  if (
    !session.expiresAt ||
    Date.now() < session.expiresAt - 60_000 ||
    !session.refreshToken
  ) {
    return;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: GRANOLA_MCP_URL,
  });

  const res = await fetch(session.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status})`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  session.accessToken = tokens.access_token;
  if (tokens.refresh_token) {
    session.refreshToken = tokens.refresh_token;
  }
  if (tokens.expires_in) {
    session.expiresAt = Date.now() + tokens.expires_in * 1000;
  }
}

async function parseMcpResponse(
  res: globalThis.Response,
  expectedId?: number
): Promise<JsonRpcResponse | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 202 || res.status === 204) {
    return null;
  }

  if (contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    if (Array.isArray(parsed)) {
      if (expectedId !== undefined) {
        return parsed.find((m) => m.id === expectedId) ?? parsed[0] ?? null;
      }
      return parsed[0] ?? null;
    }
    return parsed;
  }

  if (contentType.includes("text/event-stream")) {
    const raw = await res.text();
    const messages: JsonRpcResponse[] = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const joined = dataLines.join("\n").trim();
      if (!joined || joined === "[DONE]") continue;
      try {
        messages.push(JSON.parse(joined) as JsonRpcResponse);
      } catch {
        // Ignore non-JSON SSE control frames
      }
    }
    if (expectedId !== undefined) {
      const match = messages.find((m) => m.id === expectedId);
      if (match) return match;
    }
    return messages.at(-1) ?? null;
  }

  const fallbackText = await res.text();
  if (!fallbackText.trim()) return null;
  try {
    return JSON.parse(fallbackText) as JsonRpcResponse;
  } catch {
    throw new Error(
      `Unexpected MCP response (${res.status} ${contentType}): ${fallbackText.slice(0, 300)}`
    );
  }
}

async function sendMcpJsonRpc(
  session: GranolaSession,
  payload: Record<string, unknown>,
  expectedId?: number
): Promise<{ status: number; message: JsonRpcResponse | null }> {
  await ensureValidAccessToken(session);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${session.accessToken}`,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };

  if (session.mcpSessionId) {
    headers["MCP-Session-Id"] = session.mcpSessionId;
  }

  const res = await fetch(GRANOLA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const newSessionHeader = res.headers.get("mcp-session-id");
  if (newSessionHeader) {
    session.mcpSessionId = newSessionHeader;
  }

  if (res.status === 401) {
    const text = await res.text();
    const err = new Error(`Granola MCP unauthorized (401): ${text}`) as Error & {
      status?: number;
    };
    err.status = 401;
    throw err;
  }

  if (!res.ok && res.status !== 202 && res.status !== 204) {
    const text = await res.text();
    const err = new Error(
      `Granola MCP error (${res.status}): ${text}`
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  const message = await parseMcpResponse(res, expectedId);
  return { status: res.status, message };
}

async function initializeMcpSession(session: GranolaSession): Promise<void> {
  session.mcpSessionId = null;
  const initId = nextRpcId();
  const initRes = await sendMcpJsonRpc(
    session,
    {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "granola-gemini-gtm-workspace",
          version: "1.0.0",
        },
      },
    },
    initId
  );

  if (initRes.message?.error) {
    throw new Error(
      `MCP initialize failed: ${initRes.message.error.message}`
    );
  }

  await sendMcpJsonRpc(session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

async function callMcpMethod(
  session: GranolaSession,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!session.mcpSessionId) {
    await initializeMcpSession(session);
  }

  const runCall = async () => {
    const id = nextRpcId();
    return sendMcpJsonRpc(
      session,
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      },
      id
    );
  };

  let response;
  try {
    response = await runCall();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 400) {
      await initializeMcpSession(session);
      response = await runCall();
    } else {
      throw err;
    }
  }

  if (response.message?.error) {
    throw new Error(
      `MCP ${method} error (${response.message.error.code}): ${response.message.error.message}`
    );
  }

  return response.message?.result ?? null;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it in Settings > Secrets."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Clean up stale OAuth states periodically
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [state, entry] of pendingStates.entries()) {
      if (entry.createdAt < cutoff) {
        pendingStates.delete(state);
      }
    }
  }, 60_000);

  app.get("/api/granola/auth/url", async (req: Request, res: Response) => {
    try {
      const requestedOrigin =
        typeof req.query.origin === "string" ? req.query.origin : undefined;
      const baseUrl = resolveBaseAppUrl(requestedOrigin);
      const redirectUri = `${baseUrl}/auth/callback`;

      const { auth, resource } = await discoverGranolaOAuth();
      const client = await getOrRegisterClient(
        auth.registration_endpoint,
        redirectUri
      );

      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      const state = crypto.randomBytes(24).toString("hex");

      pendingStates.set(state, {
        codeVerifier,
        redirectUri,
        clientId: client.client_id,
        tokenEndpoint: auth.token_endpoint,
        createdAt: Date.now(),
      });

      const scope =
        resource.scopes_supported?.join(" ") || "mcp";

      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        resource: GRANOLA_MCP_URL,
      });

      const url = `${auth.authorization_endpoint}?${params.toString()}`;
      res.json({ url, redirectUri });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to initialize Granola OAuth";
      res.status(500).json({ error: message });
    }
  });

  const handleOAuthCallback = async (req: Request, res: Response) => {
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const errorDescription =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : null;
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;

    if (error) {
      const msg = errorDescription || error;
      res.status(400).send(`
        <!doctype html>
        <html>
          <body style="font-family: sans-serif; padding: 24px; color: #0f172a;">
            <p>Granola authorization declined: ${msg.replace(/[<>&"]/g, "")}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(msg)} }, '*');
                setTimeout(() => window.close(), 1200);
              }
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (!code || !state) {
      res.status(400).send("Missing OAuth code or state parameter.");
      return;
    }

    const pending = pendingStates.get(state);
    if (!pending) {
      res
        .status(400)
        .send("OAuth state expired or invalid. Please click Connect again.");
      return;
    }
    pendingStates.delete(state);

    try {
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.codeVerifier,
        resource: GRANOLA_MCP_URL,
      });

      const tokenRes = await fetch(pending.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const sessionId = crypto.randomBytes(32).toString("hex");
      const session: GranolaSession = {
        id: sessionId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
        clientId: pending.clientId,
        tokenEndpoint: pending.tokenEndpoint,
        mcpSessionId: null,
        tools: null,
      };
      sessions.set(sessionId, session);

      res.cookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });

      res.send(`
        <!doctype html>
        <html>
          <body style="font-family: sans-serif; padding: 24px; color: #0f172a;">
            <p>Connected to Granola MCP. This window will close automatically.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to complete OAuth flow";
      res.status(500).send(`
        <!doctype html>
        <html>
          <body style="font-family: sans-serif; padding: 24px; color: #991b1b;">
            <p>Authentication error: ${msg.replace(/[<>&"]/g, "")}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(msg)} }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }
  };

  app.get(["/auth/callback", "/auth/callback/"], handleOAuthCallback);

  app.get("/api/granola/status", async (req: Request, res: Response) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.json({
        connected: false,
        mcpUrl: GRANOLA_MCP_URL,
        tools: [],
      });
      return;
    }

    try {
      if (!session.tools || req.query.refresh === "1") {
        const listResult = (await callMcpMethod(session, "tools/list")) as {
          tools?: McpTool[];
        } | null;
        session.tools = listResult?.tools ?? [];
      }

      res.json({
        connected: true,
        mcpUrl: GRANOLA_MCP_URL,
        mcpSessionId: session.mcpSessionId,
        tools: session.tools,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        sessions.delete(session.id);
        res.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          path: "/",
        });
        res.json({
          connected: false,
          mcpUrl: GRANOLA_MCP_URL,
          tools: [],
          error: "Granola session expired. Please reconnect.",
        });
        return;
      }

      const message =
        err instanceof Error ? err.message : "Failed to inspect Granola MCP";
      res.status(500).json({
        connected: true,
        mcpUrl: GRANOLA_MCP_URL,
        tools: session.tools ?? [],
        error: message,
      });
    }
  });

  app.post("/api/granola/disconnect", (req: Request, res: Response) => {
    const session = getSessionFromRequest(req);
    if (session) {
      sessions.delete(session.id);
    }
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
    res.json({ connected: false });
  });

  app.post("/api/granola/tools/call", async (req: Request, res: Response) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: "Not connected to Granola MCP." });
      return;
    }

    const { name, arguments: toolArgs } = req.body as {
      name?: string;
      arguments?: Record<string, unknown>;
    };

    if (!name) {
      res.status(400).json({ error: "Tool name is required." });
      return;
    }

    try {
      const result = await callMcpMethod(session, "tools/call", {
        name,
        arguments: toolArgs ?? {},
      });
      res.json({ result });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        sessions.delete(session.id);
        res.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          path: "/",
        });
      }
      const message =
        err instanceof Error ? err.message : "Granola MCP tool call failed";
      res.status(status === 401 ? 401 : 500).json({ error: message });
    }
  });

  app.post("/api/gemini/analyze", async (req: Request, res: Response) => {
    const { prompt, contextText, meetingTitle } = req.body as {
      prompt?: string;
      contextText?: string;
      meetingTitle?: string;
    };

    if (!prompt || !contextText) {
      res
        .status(400)
        .json({ error: "Both prompt and meeting context are required." });
      return;
    }

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Meeting${meetingTitle ? ` (${meetingTitle})` : ""}:\n\n${contextText}\n\n---\n\nTask:\n${prompt}`,
        config: {
          systemInstruction:
            "You are a sharp GTM and marketing strategist analyzing real Granola meeting notes and transcripts. Be concrete, cite exact details from the meeting context, and structure outputs cleanly in markdown.",
        },
      });
      res.json({ text: response.text ?? "" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Gemini generation failed";
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/granola/import-link", async (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "A Granola note URL is required." });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      res.status(400).json({ error: "Invalid URL format." });
      return;
    }

    if (parsedUrl.hostname !== "notes.granola.ai") {
      res.status(400).json({
        error: "Only notes.granola.ai share links are supported.",
      });
      return;
    }

    try {
      const pageRes = await fetch(parsedUrl.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; GranolaGeminiGTM/1.0)",
        },
        redirect: "follow",
      });
      if (!pageRes.ok) {
        throw new Error(`Granola returned HTTP ${pageRes.status}`);
      }
      const html = await pageRes.text();

      const titleMatch = html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i
      );
      const title = titleMatch?.[1]?.trim() || "Granola Shared Meeting";

      const dateMatch = html.match(/created_at\\":\\"([^\\"]+)\\"/);
      const createdAt = dateMatch?.[1] || undefined;

      // Extract the HTML body chunk from Next.js flight stream (e.g. 62:T415,<h3>...</h3>)
      const pushes = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)];
      let extractedMarkdown = "";

      for (const match of pushes) {
        const rawChunk = match[1];
        let decoded = rawChunk;
        try {
          decoded = JSON.parse(`"${rawChunk}"`) as string;
        } catch {
          // keep raw if JSON string unescape fails
        }

        const htmlBlockMatch = decoded.match(
          /T[0-9a-f]+,(<(?:h1|h2|h3|p|ul|ol)[\s\S]*)$/i
        );
        if (htmlBlockMatch) {
          const cleanHtml = htmlBlockMatch[1]
            .replace(/<hr\s*\/?>[\s\S]*$/i, "")
            .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, "\n## $1\n")
            .replace(/<li[^>]*>/gi, "\n- ")
            .replace(/<\/li>/gi, "")
            .replace(/<p[^>]*>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          if (cleanHtml.length > extractedMarkdown.length) {
            extractedMarkdown = cleanHtml;
          }
        }
      }

      if (!extractedMarkdown) {
        const descMatch = html.match(
          /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
        );
        extractedMarkdown = descMatch?.[1]?.trim() || "";
      }

      if (!extractedMarkdown) {
        throw new Error(
          "Could not extract public note content. Make sure the Granola link is shared publicly, or connect via Granola MCP."
        );
      }

      const idMatch = parsedUrl.pathname.match(/([0-9a-f-]{36})/i);
      res.json({
        id: idMatch?.[1] || parsedUrl.pathname,
        title,
        date: createdAt,
        notes: extractedMarkdown,
        sourceUrl: parsedUrl.toString(),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to import Granola link";
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/gemini/audit", async (req: Request, res: Response) => {
    const {
      meetingTitle,
      callText,
      summaryText,
      transcriptText,
      meetingTimestamp,
      guardrailsText,
    } = req.body as {
      meetingTitle?: string;
      callText?: string;
      summaryText?: string;
      transcriptText?: string;
      meetingTimestamp?: string;
      guardrailsText?: string;
    };

    const effectiveSummary = (summaryText || callText || "").trim();
    const effectiveTranscript = (transcriptText || "").trim();

    if (!effectiveSummary && !effectiveTranscript) {
      res.status(400).json({
        error: "Call notes or transcript and guardrails are required.",
      });
      return;
    }

    if (!guardrailsText) {
      res.status(400).json({
        error: "Guardrails are required.",
      });
      return;
    }

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: [
          `APPROVED PROOF POINTS & BOUNDARIES:\n${guardrailsText}`,
          `MEETING METADATA:\nTitle: ${meetingTitle || "Sales / BD Call"}\nMeeting Timestamp: ${meetingTimestamp || "Not specified"}`,
          `MEETING SUMMARY BULLETS:\n${effectiveSummary}`,
          effectiveTranscript
            ? `VERBATIM TRANSCRIPT:\n${effectiveTranscript}`
            : `VERBATIM TRANSCRIPT:\n(No separate transcript provided; use summary bullets.)`,
          `Audit every product, performance, timeline, integration, security, and commercial claim against the Approved Proof Points & Boundaries. For each overclaim: (1) set summaryBullet to the exact verbatim line/phrase from MEETING SUMMARY BULLETS, (2) set transcriptQuote to the exact spoken snippet from VERBATIM TRANSCRIPT (or summary if absent), and (3) set transcriptTimestamp to the line timestamp if present, otherwise "${meetingTimestamp || "Recorded call"}". Also list verified compliant claims.`,
        ].join("\n\n---\n\n"),
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            "You are a fast, precise GTM deal-risk auditor. Compare the call summary and transcript strictly against the Approved Proof Points & Boundaries. Every summaryBullet MUST be an exact verbatim substring from MEETING SUMMARY BULLETS (without markdown prefix like '-' or '#'). Every transcriptQuote MUST be an exact verbatim snippet copied from VERBATIM TRANSCRIPT (or summary if transcript is absent). Only output a line-level timestamp in transcriptTimestamp if explicit timestamps appear in VERBATIM TRANSCRIPT; otherwise output the provided Meeting Timestamp. Never invent claims or timestamps. Keep all fields concise.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              prospectContact: {
                type: Type.STRING,
                description:
                  "Prospect name and/or company inferred from the call or title (e.g. 'Michael · Acme Corp').",
              },
              summary: {
                type: Type.STRING,
                description:
                  "One crisp sentence summarizing overclaims found and compliant points.",
              },
              flags: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    severity: {
                      type: Type.STRING,
                      description: "Either HIGH or MEDIUM",
                    },
                    summaryBullet: {
                      type: Type.STRING,
                      description:
                        "Exact verbatim line or phrase from MEETING SUMMARY BULLETS to highlight inline.",
                    },
                    transcriptQuote: {
                      type: Type.STRING,
                      description:
                        "Exact spoken snippet copied from VERBATIM TRANSCRIPT where the overclaim was made.",
                    },
                    transcriptTimestamp: {
                      type: Type.STRING,
                      description:
                        "Line timestamp from transcript if present, otherwise the Meeting Timestamp.",
                    },
                    ruleViolated: {
                      type: Type.STRING,
                      description:
                        "Approved proof point or boundary crossed, with exact approved numbers/dates.",
                    },
                    safeWalkBack: {
                      type: Type.STRING,
                      description:
                        "Exact 'what we can actually say' replacement phrasing.",
                    },
                  },
                  required: [
                    "category",
                    "severity",
                    "summaryBullet",
                    "transcriptQuote",
                    "transcriptTimestamp",
                    "ruleViolated",
                    "safeWalkBack",
                  ],
                },
              },
              compliantClaims: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    quote: { type: Type.STRING },
                    verifiedAgainst: { type: Type.STRING },
                  },
                  required: ["quote", "verifiedAgainst"],
                },
              },
            },
            required: [
              "prospectContact",
              "summary",
              "flags",
              "compliantClaims",
            ],
          },
        },
      });

      const raw = (response.text ?? "{}").trim();
      const parsed = JSON.parse(raw) as unknown;
      res.json({ audit: parsed });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Gemini overclaim audit failed";
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/gemini/redraft", async (req: Request, res: Response) => {
    const { meetingTitle, prospectContact, selectedFlags, tone } = req.body as {
      meetingTitle?: string;
      prospectContact?: string;
      selectedFlags?: Array<{
        category: string;
        transcriptQuote: string;
        safeWalkBack: string;
      }>;
      tone?: "warm" | "direct";
    };

    if (!selectedFlags) {
      res.status(400).json({ error: "selectedFlags is required." });
      return;
    }

    try {
      const ai = getGeminiClient();
      const toneGuide =
        tone === "direct"
          ? "Crisp, executive, concise bullet points—zero fluff, straight to exact specs and dates."
          : "Warm, collaborative, preserves deal excitement and momentum while naturally tightening expectations.";

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: [
          `MEETING: ${meetingTitle || "Discovery Call"} (${prospectContact || "Prospect"})`,
          `TONE: ${toneGuide}`,
          `ITEMS TO CLARIFY:\n${
            selectedFlags.length > 0
              ? selectedFlags
                  .map(
                    (f, i) =>
                      `${i + 1}. [${f.category}] Said: "${f.transcriptQuote}" -> Approved framing: "${f.safeWalkBack}"`
                  )
                  .join("\n")
              : "No clarifications needed—draft a standard positive post-call recap."
          }`,
        ].join("\n\n"),
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            "Draft a Client Clarification Follow-Up Email and a neutral Internal Engineering/InfoSec Slack Heads-Up covering ONLY the selected items to clarify. Format both bodies with clean, well-spaced paragraphs separated by blank lines (\\n\\n) and ALWAYS sign off both with 'Best,\\nHayden'.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              clientFollowUpEmail: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING },
                  body: {
                    type: Type.STRING,
                    description:
                      "Multi-paragraph email separated by blank lines (\\n\\n) ending with 'Best,\\nHayden'.",
                  },
                },
                required: ["subject", "body"],
              },
              internalTeamBrief: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  body: {
                    type: Type.STRING,
                    description:
                      "Multi-paragraph Slack update separated by blank lines (\\n\\n) ending with 'Best,\\nHayden'.",
                  },
                },
                required: ["title", "body"],
              },
            },
            required: ["clientFollowUpEmail", "internalTeamBrief"],
          },
        },
      });

      const raw = (response.text ?? "{}").trim();
      const parsed = JSON.parse(raw) as unknown;
      res.json(parsed);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to redraft messages";
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, "index.html");
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send("Build output not found. Run npm run build.");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
