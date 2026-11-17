import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Hash,
  Link2,
  Loader2,
  Mail,
  MessageSquareWarning,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";

type WorkspaceView = "audit" | "guardrails" | "explorer";
type ResultTab = "flags" | "email" | "brief";
type NotesViewMode = "summary" | "edit" | "transcript";
type DraftTone = "warm" | "direct";
type PaletteId = "obsidian" | "alabaster" | "cobalt" | "carbon";

const PALETTES: Array<{
  id: PaletteId;
  label: string;
  canvasHex: string;
  accentHex: string;
}> = [
  {
    id: "obsidian",
    label: "Obsidian",
    canvasHex: "#090a0d",
    accentHex: "#10b981",
  },
  {
    id: "alabaster",
    label: "Alabaster",
    canvasHex: "#f6f8fb",
    accentHex: "#047857",
  },
  {
    id: "cobalt",
    label: "Cobalt",
    canvasHex: "#070b14",
    accentHex: "#3b82f6",
  },
  {
    id: "carbon",
    label: "Carbon",
    canvasHex: "#f4f4f5",
    accentHex: "#18181b",
  },
];

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface McpCallResult {
  content?: McpCallContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface GranolaMeetingSummary {
  id: string;
  title: string;
  date?: string;
  attendees?: string[];
  rawText?: string;
}

interface GranolaStatus {
  connected: boolean;
  mcpUrl: string;
  mcpSessionId?: string | null;
  tools: McpTool[];
  error?: string;
}

interface GuardrailRule {
  id: string;
  category: string;
  approved: string;
  boundary: string;
}

interface AuditFlag {
  category: string;
  severity: string;
  summaryBullet: string;
  transcriptQuote: string;
  transcriptTimestamp: string;
  ruleViolated: string;
  safeWalkBack: string;
}

interface CompliantClaim {
  quote: string;
  verifiedAgainst: string;
}

interface OverclaimAuditResult {
  prospectContact: string;
  summary: string;
  flags: AuditFlag[];
  compliantClaims: CompliantClaim[];
  clientFollowUpEmail?: {
    subject: string;
    body: string;
  };
  internalTeamBrief?: {
    title: string;
    body: string;
  };
}

const DEFAULT_GUARDRAILS: GuardrailRule[] = [
  {
    id: "speed",
    category: "Speed & Latency",
    approved:
      "140ms median / 280ms p95 API latency up to 5,000 events/min; dashboards refresh every 15 minutes.",
    boundary:
      "DO NOT promise sub-50ms real-time streaming or unlimited throughput.",
  },
  {
    id: "benchmark",
    category: "Benchmark",
    approved:
      "89.5% precision and 42% faster resolution on 10,000 evaluated English workflows.",
    boundary:
      "DO NOT claim 99% accuracy, zero hallucinations, or full multilingual parity.",
  },
  {
    id: "timeline",
    category: "Timeline",
    approved:
      "Workflow Automation v2 enters closed beta in Q1 2027 and General Availability (GA) in Q3 2027.",
    boundary:
      "DO NOT promise Q1 2027 production launch or custom delivery dates.",
  },
  {
    id: "security",
    category: "Security & Hosting",
    approved:
      "SOC 2 Type I certified, GDPR compliant, multi-tenant US/EU cloud. SOC 2 Type II audit completes Q2 2027.",
    boundary:
      "DO NOT claim SOC 2 Type II today, FedRAMP, or self-hosted VPC.",
  },
  {
    id: "integrations",
    category: "Integrations",
    approved:
      "Native Slack, Salesforce, and HubSpot sync. Snowflake, Workday, or SAP connectors require a 4-6 week SOW.",
    boundary:
      "DO NOT promise 1-click ERP/warehouse sync or zero engineering lift.",
  },
  {
    id: "commercial",
    category: "SLA & Commercial",
    approved:
      "99.9% uptime SLA, 4h business-day support, $15K / 30-day pilot (credited to annual ACV). 99.99% SLA is Enterprise ($75K+ ACV) only.",
    boundary:
      "DO NOT promise 99.99% on standard tiers, free pilots, or custom features in contract.",
  },
];

function formatGuardrailsAsText(rules: GuardrailRule[]): string {
  return rules
    .map(
      (r, idx) =>
        `${idx + 1}. ${r.category.toUpperCase()}: Approved: ${r.approved} Boundary: ${r.boundary}`
    )
    .join("\n");
}

function extractMcpText(result: McpCallResult | null | undefined): string {
  if (!result) return "";
  if (Array.isArray(result.content) && result.content.length > 0) {
    const texts = result.content
      .map((item) => {
        if (typeof item.text === "string") return item.text;
        return JSON.stringify(item, null, 2);
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n\n");
  }
  if (result.structuredContent !== undefined) {
    return typeof result.structuredContent === "string"
      ? result.structuredContent
      : JSON.stringify(result.structuredContent, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

function parseGranolaSummaryXml(raw: string): {
  summary: string;
  date?: string;
} {
  const dateAttrMatch = raw.match(/<meeting\b[^>]*\bdate="([^"]+)"/i);
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  const privateNotesMatch = raw.match(
    /<private_notes\b[^>]*>([\s\S]*?)<\/private_notes>/i
  );

  if (!summaryMatch && !privateNotesMatch) {
    return { summary: raw.trim(), date: dateAttrMatch?.[1] };
  }

  const parts: string[] = [];
  if (summaryMatch?.[1]?.trim()) {
    const normalizedLines = summaryMatch[1]
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim();
        if (!t) return "";
        if (t.startsWith("# ")) return `## ${t.slice(2)}`;
        if (t.startsWith("## ") || t.startsWith("### ")) return t;
        if (t.startsWith("- ") || t.startsWith("* ")) return t;
        return `- ${t}`;
      })
      .filter(Boolean);
    parts.push(normalizedLines.join("\n"));
  }

  if (privateNotesMatch?.[1]?.trim()) {
    parts.push(`## Private Notes\n${privateNotesMatch[1].trim()}`);
  }

  return {
    summary: parts.join("\n\n").trim(),
    date: dateAttrMatch?.[1],
  };
}

function parseGranolaTranscriptJson(raw: string): {
  transcript: string;
  timestamp?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { transcript: "" };

  try {
    const parsed = JSON.parse(trimmed) as {
      transcript?: string;
      created_at?: string;
      meeting_at?: string;
    };
    if (parsed && typeof parsed.transcript === "string") {
      const ts = parsed.meeting_at || parsed.created_at;
      const formattedTs = ts
        ? new Date(ts).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : undefined;
      return {
        transcript: parsed.transcript.trim(),
        timestamp: formattedTs,
      };
    }
  } catch {
    // Plain text transcript fallback
  }

  return { transcript: trimmed };
}

function parseMeetingsFromMcpResult(
  result: McpCallResult | null | undefined
): { meetings: GranolaMeetingSummary[]; rawText: string } {
  const rawText = extractMcpText(result);
  if (!result) return { meetings: [], rawText: "" };

  const candidates: unknown[] = [];
  if (result.structuredContent && typeof result.structuredContent === "object") {
    const sc = result.structuredContent as Record<string, unknown>;
    if (Array.isArray(sc)) {
      candidates.push(...sc);
    } else if (Array.isArray(sc.meetings)) {
      candidates.push(...sc.meetings);
    } else if (Array.isArray(sc.items)) {
      candidates.push(...sc.items);
    }
  }

  if (candidates.length === 0 && rawText.trim()) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (Array.isArray(parsed)) {
        candidates.push(...parsed);
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.meetings)) candidates.push(...obj.meetings);
        else if (Array.isArray(obj.results)) candidates.push(...obj.results);
        else if (Array.isArray(obj.data)) candidates.push(...obj.data);
      }
    } catch {
      // Fallback to XML parsing
    }
  }

  if (candidates.length > 0) {
    const normalized: GranolaMeetingSummary[] = [];
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = String(obj.id ?? obj.meeting_id ?? obj.document_id ?? "");
      if (!id) continue;
      const title = String(obj.title ?? obj.name ?? "Untitled Meeting");
      const date =
        typeof obj.date === "string"
          ? obj.date
          : typeof obj.created_at === "string"
          ? obj.created_at
          : typeof obj.start_time === "string"
          ? obj.start_time
          : undefined;
      const attendeesRaw = obj.attendees ?? obj.participants;
      const attendees = Array.isArray(attendeesRaw)
        ? attendeesRaw
            .map((a) =>
              typeof a === "string"
                ? a
                : String(
                    (a as Record<string, unknown>)?.name ??
                      (a as Record<string, unknown>)?.email ??
                      ""
                  )
            )
            .filter(Boolean)
        : undefined;
      normalized.push({ id, title, date, attendees });
    }
    if (normalized.length > 0) {
      return { meetings: normalized, rawText };
    }
  }

  const xmlMatches: GranolaMeetingSummary[] = [];
  const meetingTagRegex =
    /<meeting\b([^>]*)>([\s\S]*?)<\/meeting>|<meeting\b([^/>]*)\/>/gi;
  let match: RegExpExecArray | null;
  while ((match = meetingTagRegex.exec(rawText)) !== null) {
    const attrs = match[1] || match[3] || "";
    const body = match[2] || "";
    const getAttr = (attrName: string): string | undefined => {
      const m = new RegExp(`${attrName}=["']([^"']*)["']`, "i").exec(attrs);
      return m?.[1];
    };
    const id = getAttr("id");
    const title = getAttr("title") || getAttr("name");
    const date = getAttr("date") || getAttr("created_at");
    if (id) {
      xmlMatches.push({
        id,
        title: title || "Untitled Meeting",
        date,
        rawText: body.trim() || undefined,
      });
    }
  }

  if (xmlMatches.length > 0) {
    return { meetings: xmlMatches, rawText };
  }

  return { meetings: [], rawText };
}

function buildDefaultToolArgs(tool: McpTool | undefined): string {
  if (!tool?.inputSchema) return "{}";
  const props = tool.inputSchema.properties as
    | Record<string, { type?: string }>
    | undefined;
  if (!props) return "{}";
  const sample: Record<string, unknown> = {};
  const required = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as string[])
    : [];
  for (const key of Object.keys(props)) {
    if (required.includes(key) || Object.keys(props).length <= 3) {
      const t = props[key]?.type;
      if (t === "array") sample[key] = [];
      else if (t === "number" || t === "integer") sample[key] = 10;
      else if (t === "boolean") sample[key] = false;
      else sample[key] = "";
    }
  }
  return JSON.stringify(sample, null, 2);
}

function findMatchingFlagsForLine(
  line: string,
  flags: AuditFlag[]
): number[] {
  const normalizedLine = line.replace(/\*\*/g, "").trim().toLowerCase();
  if (!normalizedLine) return [];

  const matched: number[] = [];
  flags.forEach((flag, idx) => {
    const target = (flag.summaryBullet || flag.transcriptQuote || "")
      .replace(/^[-*\s"“]+|["”\s]+$/g, "")
      .replace(/\*\*/g, "")
      .trim()
      .toLowerCase();
    if (!target) return;

    if (
      normalizedLine.includes(target) ||
      (normalizedLine.length >= 14 && target.includes(normalizedLine))
    ) {
      matched.push(idx);
    }
  });
  return matched;
}

function formatCleanLine(text: string): string {
  return text.replace(/\*\*/g, "");
}

function ProoflineLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect
        x="0.5"
        y="0.5"
        width="27"
        height="27"
        rx="7"
        fill="var(--pl-logo-bg)"
        stroke="rgba(255,255,255,0.16)"
      />
      <path
        d="M7.5 15.5L13 7.5L17.5 13.5L20.5 10"
        stroke="#FFFFFF"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 19.5H21.5"
        stroke="var(--pl-logo-stroke)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="20.5" cy="10" r="1.75" fill="var(--pl-logo-stroke)" />
    </svg>
  );
}

export default function App() {
  const [palette, setPalette] = useState<PaletteId>(() => {
    try {
      const saved = localStorage.getItem("proofline_palette");
      if (
        saved === "obsidian" ||
        saved === "alabaster" ||
        saved === "cobalt" ||
        saved === "carbon"
      ) {
        return saved;
      }
    } catch {
      // ignore storage access issues
    }
    return "obsidian";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-palette", palette);
    try {
      localStorage.setItem("proofline_palette", palette);
    } catch {
      // ignore storage access issues
    }
  }, [palette]);

  const [activeView, setActiveView] = useState<WorkspaceView>("audit");
  const [status, setStatus] = useState<GranolaStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Guardrails state
  const [guardrails, setGuardrails] =
    useState<GuardrailRule[]>(DEFAULT_GUARDRAILS);

  // Granola calls state
  const [meetings, setMeetings] = useState<GranolaMeetingSummary[]>([]);
  const [loadingMeetings, setLoadingMeetings] = useState(false);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>("");
  const [callTitle, setCallTitle] = useState<string>("");
  const [callDate, setCallDate] = useState<string>("");
  const [callSourceLabel, setCallSourceLabel] = useState<string>("");
  const [callText, setCallText] = useState<string>("");
  const [transcriptText, setTranscriptText] = useState<string>("");
  const [loadingMeetingDetail, setLoadingMeetingDetail] = useState(false);
  const [notesViewMode, setNotesViewMode] = useState<NotesViewMode>("summary");

  // Granola share link import state
  const [granolaLink, setGranolaLink] = useState<string>("");
  const [importingLink, setImportingLink] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Audit output state
  const [auditResult, setAuditResult] = useState<OverclaimAuditResult | null>(
    null
  );
  const [includedFlags, setIncludedFlags] = useState<Record<number, boolean>>(
    {}
  );
  const [activeFlagIndex, setActiveFlagIndex] = useState<number | null>(null);
  const [hoveredLineIdx, setHoveredLineIdx] = useState<number | null>(null);
  const [draftTone, setDraftTone] = useState<DraftTone>("warm");
  const [redrafting, setRedrafting] = useState(false);
  const [resultTab, setResultTab] = useState<ResultTab>("flags");
  const [runningAudit, setRunningAudit] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // MCP Explorer state
  const [selectedToolName, setSelectedToolName] = useState<string>("");
  const [toolArgsJson, setToolArgsJson] = useState<string>("{}");
  const [toolOutput, setToolOutput] = useState<string>("");
  const [runningTool, setRunningTool] = useState(false);
  const [toolCallError, setToolCallError] = useState<string | null>(null);

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const callGranolaTool = useCallback(
    async (
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<McpCallResult> => {
      const res = await fetch("/api/granola/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      });
      const data = (await res.json()) as {
        result?: McpCallResult;
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 401) {
          setStatus((prev) =>
            prev ? { ...prev, connected: false, tools: [] } : null
          );
        }
        throw new Error(data.error || `Tool ${name} failed (${res.status})`);
      }
      if (!data.result) {
        throw new Error(`Tool ${name} returned an empty response.`);
      }
      if (data.result.isError) {
        throw new Error(extractMcpText(data.result) || `Tool ${name} errored.`);
      }
      return data.result;
    },
    []
  );

  const handleSelectMcpMeeting = useCallback(
    async (
      meeting: GranolaMeetingSummary,
      availableTools: McpTool[]
    ): Promise<void> => {
      setSelectedMeetingId(meeting.id);
      setCallTitle(meeting.title);
      setCallDate(meeting.date || "");
      setCallSourceLabel("Granola MCP");
      setLoadingMeetingDetail(true);
      setMeetingsError(null);
      setAuditResult(null);
      setAuditError(null);
      setActiveFlagIndex(null);
      setHoveredLineIdx(null);
      setNotesViewMode("summary");

      const hasGetMeetings = availableTools.some(
        (t) => t.name === "get_meetings"
      );
      const transcriptTool = availableTools.find(
        (t) => t.name === "get_meeting_transcript"
      );

      try {
        let rawNotes = meeting.rawText || "";
        if (hasGetMeetings) {
          const res = await callGranolaTool("get_meetings", {
            meeting_ids: [meeting.id],
          });
          rawNotes = extractMcpText(res);
        }

        const parsedSummary = parseGranolaSummaryXml(rawNotes);
        setCallText(parsedSummary.summary);
        if (parsedSummary.date) {
          setCallDate(parsedSummary.date);
        }

        let cleanTranscript = "";
        if (transcriptTool) {
          const schemaProps = (transcriptTool.inputSchema?.properties ??
            {}) as Record<string, unknown>;
          const baseArgs: Record<string, unknown> = { meeting_id: meeting.id };
          const withTimestamps =
            "include_timestamps" in schemaProps
              ? { ...baseArgs, include_timestamps: true }
              : baseArgs;

          try {
            const tRes = await callGranolaTool(
              "get_meeting_transcript",
              withTimestamps
            );
            const parsedT = parseGranolaTranscriptJson(extractMcpText(tRes));
            if (
              parsedT.transcript &&
              !parsedT.transcript.toLowerCase().includes("upgrade")
            ) {
              cleanTranscript = parsedT.transcript;
            }
          } catch {
            // Fallback without include_timestamps if rejected
            try {
              const tRes = await callGranolaTool(
                "get_meeting_transcript",
                baseArgs
              );
              const parsedT = parseGranolaTranscriptJson(extractMcpText(tRes));
              if (
                parsedT.transcript &&
                !parsedT.transcript.toLowerCase().includes("upgrade")
              ) {
                cleanTranscript = parsedT.transcript;
              }
            } catch {
              // Transcript optional on basic plans
            }
          }
        }
        setTranscriptText(cleanTranscript);
      } catch (err) {
        setMeetingsError(
          err instanceof Error ? err.message : "Failed to load meeting notes"
        );
      } finally {
        setLoadingMeetingDetail(false);
      }
    },
    [callGranolaTool]
  );

  const loadMeetings = useCallback(
    async (availableTools: McpTool[]) => {
      const hasListMeetings = availableTools.some(
        (t) => t.name === "list_meetings"
      );
      if (!hasListMeetings) return;

      setLoadingMeetings(true);
      setMeetingsError(null);
      try {
        const result = await callGranolaTool("list_meetings", {});
        const parsed = parseMeetingsFromMcpResult(result);
        setMeetings(parsed.meetings);
        if (parsed.meetings.length > 0 && !callText) {
          await handleSelectMcpMeeting(parsed.meetings[0], availableTools);
        }
      } catch (err) {
        setMeetingsError(
          err instanceof Error ? err.message : "Failed to load Granola meetings"
        );
      } finally {
        setLoadingMeetings(false);
      }
    },
    [callGranolaTool, callText, handleSelectMcpMeeting]
  );

  const fetchStatus = useCallback(
    async (refreshTools = false) => {
      setCheckingStatus(true);
      try {
        const res = await fetch(
          `/api/granola/status${refreshTools ? "?refresh=1" : ""}`
        );
        const data = (await res.json()) as GranolaStatus;
        setStatus(data);
        if (data.error) setAuthError(data.error);
        if (data.connected && data.tools.length > 0) {
          setSelectedToolName((prev) => prev || data.tools[0].name);
          setToolArgsJson((prev) =>
            prev === "{}" ? buildDefaultToolArgs(data.tools[0]) : prev
          );
          await loadMeetings(data.tools);
        }
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : "Failed to check Granola status"
        );
      } finally {
        setCheckingStatus(false);
      }
    },
    [loadMeetings]
  );

  useEffect(() => {
    void fetchStatus(false);
  }, [fetchStatus]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith(".run.app") && !origin.includes("localhost")) {
        return;
      }
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setConnecting(false);
        setAuthError(null);
        void fetchStatus(true);
      } else if (event.data?.type === "OAUTH_AUTH_ERROR") {
        setConnecting(false);
        setAuthError(
          String(event.data?.error || "Granola authorization failed.")
        );
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchStatus]);

  const handleConnect = async () => {
    setAuthError(null);
    setConnecting(true);
    try {
      const res = await fetch(
        `/api/granola/auth/url?origin=${encodeURIComponent(window.location.origin)}`
      );
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Unable to construct Granola OAuth URL");
      }

      const authWindow = window.open(
        data.url,
        "granola_mcp_oauth",
        "width=620,height=740"
      );

      if (!authWindow) {
        setConnecting(false);
        setAuthError(
          "Popup was blocked by your browser. Please allow popups for this site and click Connect Granola again."
        );
      }
    } catch (err) {
      setConnecting(false);
      setAuthError(
        err instanceof Error ? err.message : "Failed to start Granola OAuth"
      );
    }
  };

  const handleDisconnect = async () => {
    await fetch("/api/granola/disconnect", { method: "POST" });
    setStatus({
      connected: false,
      mcpUrl: "https://mcp.granola.ai/mcp",
      tools: [],
    });
    setMeetings([]);
    setSelectedMeetingId("");
  };

  const handleImportLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!granolaLink.trim()) return;

    setImportingLink(true);
    setImportError(null);
    setAuditResult(null);
    setAuditError(null);
    setActiveFlagIndex(null);
    setHoveredLineIdx(null);
    setNotesViewMode("summary");
    try {
      const res = await fetch("/api/granola/import-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: granolaLink.trim() }),
      });
      const data = (await res.json()) as {
        id?: string;
        title?: string;
        date?: string;
        notes?: string;
        error?: string;
      };
      if (!res.ok || !data.notes) {
        throw new Error(data.error || "Failed to load Granola share link");
      }
      setSelectedMeetingId(data.id || "");
      setCallTitle(data.title || "Granola Shared Note");
      setCallDate(
        data.date
          ? new Date(data.date).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : "Shared Note"
      );
      setCallSourceLabel("Granola Share Link");
      setCallText(data.notes);
      setTranscriptText("");
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to import Granola link"
      );
    } finally {
      setImportingLink(false);
    }
  };

  const handleRunAudit = async () => {
    if (!callText.trim() && !transcriptText.trim()) {
      setAuditError(
        "Load a meeting from Granola MCP, import a Granola share link, or paste call notes first."
      );
      return;
    }

    setRunningAudit(true);
    setAuditError(null);
    setActiveFlagIndex(null);
    setHoveredLineIdx(null);
    try {
      const res = await fetch("/api/gemini/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingTitle: callTitle || "Sales / BD Call",
          summaryText: callText,
          transcriptText,
          meetingTimestamp: callDate || "Recorded call",
          guardrailsText: formatGuardrailsAsText(guardrails),
        }),
      });
      const data = (await res.json()) as {
        audit?: OverclaimAuditResult;
        error?: string;
      };
      if (!res.ok || !data.audit) {
        throw new Error(data.error || "Overclaim audit failed");
      }
      setAuditResult(data.audit);
      const initialIncluded: Record<number, boolean> = {};
      data.audit.flags.forEach((_, idx) => {
        initialIncluded[idx] = true;
      });
      setIncludedFlags(initialIncluded);
      setNotesViewMode("summary");
      setResultTab("flags");
      setRunningAudit(false);

      // Phase 2: Generate Client Follow-Up & Engineering Slack Brief immediately in background
      setRedrafting(true);
      try {
        const draftRes = await fetch("/api/gemini/redraft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meetingTitle: callTitle || "Discovery Call",
            prospectContact: data.audit.prospectContact,
            selectedFlags: data.audit.flags,
            tone: draftTone,
          }),
        });
        const draftData = (await draftRes.json()) as {
          clientFollowUpEmail?: { subject: string; body: string };
          internalTeamBrief?: { title: string; body: string };
        };
        if (
          draftRes.ok &&
          draftData.clientFollowUpEmail &&
          draftData.internalTeamBrief
        ) {
          setAuditResult((prev) =>
            prev
              ? {
                  ...prev,
                  clientFollowUpEmail: draftData.clientFollowUpEmail,
                  internalTeamBrief: draftData.internalTeamBrief,
                }
              : null
          );
        }
      } catch {
        // User can retry via tone toggle if background draft fails
      } finally {
        setRedrafting(false);
      }
    } catch (err) {
      setAuditError(
        err instanceof Error ? err.message : "Failed to run overclaim audit"
      );
      setRunningAudit(false);
    }
  };

  const handleRedraft = async (
    nextTone: DraftTone,
    overrideIncluded?: Record<number, boolean>
  ) => {
    if (!auditResult) return;
    const map = overrideIncluded ?? includedFlags;
    const selectedFlags = auditResult.flags.filter((_, idx) => map[idx] !== false);

    setDraftTone(nextTone);
    setRedrafting(true);
    setAuditError(null);
    try {
      const res = await fetch("/api/gemini/redraft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingTitle: callTitle || "Discovery Call",
          prospectContact: auditResult.prospectContact,
          selectedFlags,
          tone: nextTone,
        }),
      });
      const data = (await res.json()) as {
        clientFollowUpEmail?: { subject: string; body: string };
        internalTeamBrief?: { title: string; body: string };
        error?: string;
      };
      if (!res.ok || !data.clientFollowUpEmail || !data.internalTeamBrief) {
        throw new Error(data.error || "Failed to update drafts");
      }
      setAuditResult((prev) =>
        prev
          ? {
              ...prev,
              clientFollowUpEmail: data.clientFollowUpEmail!,
              internalTeamBrief: data.internalTeamBrief!,
            }
          : null
      );
    } catch (err) {
      setAuditError(
        err instanceof Error ? err.message : "Failed to redraft messages"
      );
    } finally {
      setRedrafting(false);
    }
  };

  const handleRunExplorerTool = async () => {
    if (!selectedToolName) return;
    setRunningTool(true);
    setToolCallError(null);
    setToolOutput("");

    try {
      const parsedArgs = toolArgsJson.trim()
        ? (JSON.parse(toolArgsJson) as Record<string, unknown>)
        : {};
      const res = await callGranolaTool(selectedToolName, parsedArgs);
      const text = extractMcpText(res);
      setToolOutput(text || JSON.stringify(res, null, 2));
    } catch (err) {
      setToolCallError(
        err instanceof Error ? err.message : "Tool execution failed"
      );
    } finally {
      setRunningTool(false);
    }
  };

  const activeTool = useMemo(
    () => status?.tools.find((t) => t.name === selectedToolName),
    [status?.tools, selectedToolName]
  );

  const selectedFlagCount = useMemo(() => {
    if (!auditResult) return 0;
    return auditResult.flags.filter((_, i) => includedFlags[i] !== false).length;
  }, [auditResult, includedFlags]);

  const isConnected = Boolean(status?.connected);

  return (
    <div className="min-h-screen bg-[var(--pl-bg)] text-[var(--pl-text)] flex flex-col">
      {/* Top Bar Contract: strictly 3 zones */}
      <header className="sticky top-0 z-20 bg-[var(--pl-header)] backdrop-blur-md border-b border-[var(--pl-border)] px-6 h-15 flex items-center justify-between gap-8">
        <a
          href="/"
          className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-[var(--pl-text)] whitespace-nowrap shrink-0"
        >
          <ProoflineLogo size={26} />
          <span>Proofline</span>
        </a>

        <nav className="flex items-center gap-7 text-sm font-medium text-[var(--pl-text-secondary)]">
          <button
            type="button"
            onClick={() => setActiveView("audit")}
            className={`whitespace-nowrap shrink-0 h-15 border-b-2 transition-colors cursor-pointer ${
              activeView === "audit"
                ? "text-[var(--pl-text)] border-[var(--pl-accent)]"
                : "border-transparent hover:text-[var(--pl-text)]"
            }`}
          >
            Overclaim Audit
          </button>
          <button
            type="button"
            onClick={() => setActiveView("guardrails")}
            className={`whitespace-nowrap shrink-0 h-15 border-b-2 transition-colors tabular-nums cursor-pointer ${
              activeView === "guardrails"
                ? "text-[var(--pl-text)] border-[var(--pl-accent)]"
                : "border-transparent hover:text-[var(--pl-text)]"
            }`}
          >
            Guardrails ({guardrails.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveView("explorer")}
            className={`whitespace-nowrap shrink-0 h-15 border-b-2 transition-colors cursor-pointer ${
              activeView === "explorer"
                ? "text-[var(--pl-text)] border-[var(--pl-accent)]"
                : "border-transparent hover:text-[var(--pl-text)]"
            }`}
          >
            MCP Explorer
          </button>
        </nav>

        <div className="shrink-0">
          {isConnected ? (
            <button
              type="button"
              onClick={handleDisconnect}
              className="h-9 px-3.5 text-xs font-medium text-[var(--pl-text-secondary)] bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-lg hover:bg-[var(--pl-surface-hover)] hover:text-[var(--pl-text)] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-2 cursor-pointer"
            >
              <Unplug className="w-3.5 h-3.5 text-[var(--pl-text-muted)]" />
              <span>Disconnect</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || checkingStatus}
              className="h-9 px-4 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer"
            >
              {connecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowUpRight className="w-3.5 h-3.5" />
              )}
              <span>{connecting ? "Authorizing..." : "Connect Granola"}</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 lg:px-8 space-y-5">
        {authError && (
          <div
            role="alert"
            className="bg-[var(--pl-danger-soft)] border border-[var(--pl-danger-border)] rounded-lg px-4 py-3 text-sm text-[var(--pl-danger-ink)] flex items-start justify-between gap-4"
          >
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="text-xs font-medium text-[var(--pl-danger-text)] hover:underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeView === "audit" && (
          <div className="space-y-5">
            {/* Hero Action Bar + Inline Palette Selector */}
            <section className="bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl p-5 space-y-4">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h1 className="text-lg font-semibold text-[var(--pl-text)] tracking-[-0.02em]">
                    Post-Call Overclaim Checker
                  </h1>
                  <p className="text-xs text-[var(--pl-text-secondary)] tabular-nums">
                    {isConnected
                      ? `Granola MCP connected · ${meetings.length} meetings synced · ${guardrails.length} Q4 2026 guardrails active`
                      : `Granola MCP & Gemini · Audits call commitments against ${guardrails.length} approved proof points`}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <form
                    onSubmit={handleImportLink}
                    className="flex items-center gap-2"
                  >
                    <div className="relative">
                      <Link2 className="w-3.5 h-3.5 text-[var(--pl-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="url"
                        value={granolaLink}
                        onChange={(e) => setGranolaLink(e.target.value)}
                        placeholder="Paste notes.granola.ai/t/... link"
                        className="h-9 w-64 sm:w-72 pl-8.5 pr-3 text-xs bg-[var(--pl-surface-inset)] text-[var(--pl-text)] placeholder:text-[var(--pl-text-muted)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)] transition-colors"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={importingLink || !granolaLink.trim()}
                      className="h-9 px-3.5 text-xs font-medium text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg hover:bg-[var(--pl-surface-hover)] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {importingLink && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      )}
                      <span>Load Link</span>
                    </button>
                  </form>

                  <button
                    type="button"
                    onClick={() => void handleRunAudit()}
                    disabled={
                      runningAudit ||
                      (!callText.trim() && !transcriptText.trim())
                    }
                    className="h-9 px-4 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-2 cursor-pointer"
                  >
                    {runningAudit ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {runningAudit ? "Scanning Call..." : "Scan for Overclaims"}
                    </span>
                  </button>
                </div>
              </div>

              {/* Inline Palette Selector Strip */}
              <div className="pt-3 border-t border-[var(--pl-border)] flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-[var(--pl-text-muted)]">
                  Workspace palette
                </span>
                <div
                  role="radiogroup"
                  aria-label="Workspace color palette"
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {PALETTES.map((item) => {
                    const isSelected = palette === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setPalette(item.id)}
                        className={`h-7 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-2 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isSelected
                            ? "bg-[var(--pl-surface-inset)] text-[var(--pl-text)] border-[var(--pl-border-strong)]"
                            : "bg-transparent text-[var(--pl-text-muted)] border-transparent hover:text-[var(--pl-text)] hover:bg-[var(--pl-surface-inset)]"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="w-3.5 h-3.5 rounded-sm border border-white/20 shrink-0 overflow-hidden grid grid-cols-2"
                        >
                          <span style={{ backgroundColor: item.canvasHex }} />
                          <span style={{ backgroundColor: item.accentHex }} />
                        </span>
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {importError && (
              <div className="bg-[var(--pl-danger-soft)] border border-[var(--pl-danger-border)] rounded-lg px-4 py-3 text-sm text-[var(--pl-danger-ink)]">
                {importError}
              </div>
            )}

            {meetingsError && (
              <div className="bg-[var(--pl-danger-soft)] border border-[var(--pl-danger-border)] rounded-lg px-4 py-3 text-sm text-[var(--pl-danger-ink)]">
                {meetingsError}
              </div>
            )}

            {/* Main 2-Column Split */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Left Column: Clean Bullet-Point Summary + Hover Evidence Box */}
              <section className="lg:col-span-5 bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--pl-border)] pb-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-[var(--pl-text)]">
                      Granola Call Summary
                    </h2>
                    <p className="text-xs text-[var(--pl-text-muted)] mt-0.5 truncate tabular-nums">
                      {callSourceLabel
                        ? `${callSourceLabel}${callDate ? ` · ${callDate}` : ""}`
                        : "Connect Granola MCP or load a share link"}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-0.5 p-0.5 bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg">
                      <button
                        type="button"
                        onClick={() => setNotesViewMode("summary")}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                          notesViewMode === "summary"
                            ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                            : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                        }`}
                      >
                        Summary
                      </button>
                      <button
                        type="button"
                        onClick={() => setNotesViewMode("edit")}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                          notesViewMode === "edit"
                            ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                            : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                        }`}
                      >
                        Edit
                      </button>
                      {transcriptText && (
                        <button
                          type="button"
                          onClick={() => setNotesViewMode("transcript")}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                            notesViewMode === "transcript"
                              ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                              : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                          }`}
                        >
                          Transcript
                        </button>
                      )}
                    </div>

                    {isConnected && (
                      <button
                        type="button"
                        onClick={() => void loadMeetings(status?.tools ?? [])}
                        disabled={loadingMeetings}
                        className="p-1.5 text-[var(--pl-text-muted)] hover:text-[var(--pl-text)] rounded-md hover:bg-[var(--pl-surface-inset)] transition-colors shrink-0 cursor-pointer"
                        title="Sync meetings from Granola MCP"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${loadingMeetings ? "animate-spin" : ""}`}
                        />
                      </button>
                    )}
                  </div>
                </div>

                {isConnected && meetings.length > 0 && (
                  <div>
                    <label
                      htmlFor="meeting-picker"
                      className="text-xs font-medium text-[var(--pl-text-muted)] block mb-1.5"
                    >
                      Synced Granola Meetings
                    </label>
                    <select
                      id="meeting-picker"
                      value={selectedMeetingId}
                      onChange={(e) => {
                        const found = meetings.find(
                          (m) => m.id === e.target.value
                        );
                        if (found) {
                          void handleSelectMcpMeeting(
                            found,
                            status?.tools ?? []
                          );
                        }
                      }}
                      className="w-full h-9 px-3 text-xs bg-[var(--pl-surface-inset)] text-[var(--pl-text)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)]"
                    >
                      {meetings.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.title}
                          {m.date ? ` (${m.date})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {callTitle && (
                  <div className="text-[15px] font-semibold text-[var(--pl-text)] tracking-[-0.01em]">
                    {callTitle}
                  </div>
                )}

                {loadingMeetingDetail ? (
                  <div className="space-y-2.5 py-6">
                    <div className="h-4 bg-[var(--pl-surface-inset)] rounded w-3/4 animate-pulse" />
                    <div className="h-4 bg-[var(--pl-surface-inset)] rounded w-full animate-pulse" />
                    <div className="h-4 bg-[var(--pl-surface-inset)] rounded w-5/6 animate-pulse" />
                  </div>
                ) : notesViewMode === "summary" ? (
                  callText.trim() ? (
                    <div className="p-4 bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg space-y-2 text-[13.5px] text-[var(--pl-text)] leading-relaxed">
                      {callText.split(/\r?\n/).map((line, lineIdx) => {
                        const trimmed = line.trim();
                        if (!trimmed) {
                          return <div key={lineIdx} className="h-1" />;
                        }

                        if (
                          trimmed.startsWith("## ") ||
                          trimmed.startsWith("# ")
                        ) {
                          const heading = trimmed.replace(/^#{1,3}\s+/, "");
                          return (
                            <h3
                              key={lineIdx}
                              className="text-xs font-semibold text-[var(--pl-text-muted)] pt-2.5 first:pt-0 tracking-wide"
                            >
                              {heading}
                            </h3>
                          );
                        }

                        const isBullet =
                          trimmed.startsWith("- ") || trimmed.startsWith("* ");
                        const cleanLine = formatCleanLine(
                          isBullet ? trimmed.slice(2) : trimmed
                        );

                        const matchedIndices = auditResult
                          ? findMatchingFlagsForLine(
                              cleanLine,
                              auditResult.flags
                            )
                          : [];
                        const primaryFlagIdx =
                          matchedIndices.length > 0 ? matchedIndices[0] : null;
                        const matchedFlag =
                          primaryFlagIdx !== null && auditResult
                            ? auditResult.flags[primaryFlagIdx]
                            : null;
                        const isHovered = hoveredLineIdx === lineIdx;
                        const isActive =
                          primaryFlagIdx !== null &&
                          activeFlagIndex === primaryFlagIdx;

                        if (!matchedFlag) {
                          return (
                            <div
                              key={lineIdx}
                              className={
                                isBullet
                                  ? "flex items-start gap-2.5 pl-0.5 text-[var(--pl-text-secondary)]"
                                  : "text-[var(--pl-text-secondary)]"
                              }
                            >
                              {isBullet && (
                                <span className="text-[var(--pl-text-muted)] select-none mt-0.5">
                                  •
                                </span>
                              )}
                              <span>{cleanLine}</span>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={lineIdx}
                            className="relative"
                            onMouseEnter={() => setHoveredLineIdx(lineIdx)}
                            onMouseLeave={() =>
                              setHoveredLineIdx((prev) =>
                                prev === lineIdx ? null : prev
                              )
                            }
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setActiveFlagIndex(primaryFlagIdx);
                                setResultTab("flags");
                              }}
                              onFocus={() => setHoveredLineIdx(lineIdx)}
                              onBlur={() =>
                                setHoveredLineIdx((prev) =>
                                  prev === lineIdx ? null : prev
                                )
                              }
                              style={{
                                backgroundColor:
                                  isActive || isHovered
                                    ? "var(--pl-danger-soft-hover)"
                                    : "var(--pl-danger-soft)",
                                borderColor: "var(--pl-danger-border)",
                                color: "var(--pl-danger-ink)",
                              }}
                              className="w-full text-left flex items-start gap-2 px-2.5 py-1.5 -mx-1 rounded-md border transition-colors cursor-pointer"
                            >
                              <span
                                style={{ color: "var(--pl-danger-text)" }}
                                className="select-none mt-0.5 font-bold"
                              >
                                •
                              </span>
                              <span
                                style={{
                                  textDecorationColor: "var(--pl-danger-line)",
                                }}
                                className="flex-1 underline decoration-2 underline-offset-4"
                              >
                                {cleanLine}
                              </span>
                            </button>

                            {/* Hover Box showing actual spoken transcript snippet & timestamp */}
                            {isHovered && (
                              <div
                                role="tooltip"
                                className="absolute left-0 top-full mt-1.5 w-full min-w-[280px] z-30 bg-[var(--pl-tooltip-bg)] text-[var(--pl-tooltip-text)] rounded-lg p-3.5 shadow-xl border border-[var(--pl-tooltip-border)] space-y-2 pointer-events-none"
                              >
                                <div className="flex items-center justify-between gap-2 text-xs">
                                  <span
                                    style={{ color: "var(--pl-danger-text)" }}
                                    className="font-semibold inline-flex items-center gap-1"
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5" />
                                    Transcript Evidence
                                  </span>
                                  <span className="font-mono text-[var(--pl-tooltip-muted)] inline-flex items-center gap-1 tabular-nums">
                                    <Clock className="w-3 h-3" />
                                    {matchedFlag.transcriptTimestamp ||
                                      callDate ||
                                      "Recorded call"}
                                  </span>
                                </div>
                                <p className="text-xs text-[var(--pl-tooltip-text)] leading-relaxed italic">
                                  “{matchedFlag.transcriptQuote}”
                                </p>
                                <div className="text-xs text-[var(--pl-tooltip-muted)] border-t border-[var(--pl-tooltip-border)] pt-1.5">
                                  Crosses: {matchedFlag.category}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-8 bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg text-center text-xs text-[var(--pl-text-muted)]">
                      Connect Granola above, paste a Granola share link, or
                      switch to{" "}
                      <span className="font-medium text-[var(--pl-text)]">
                        Edit
                      </span>{" "}
                      to paste notes.
                    </div>
                  )
                ) : notesViewMode === "edit" ? (
                  <textarea
                    value={callText}
                    onChange={(e) => setCallText(e.target.value)}
                    rows={16}
                    placeholder="Paste or edit Granola summary bullet points here..."
                    className="w-full p-3.5 text-xs text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg leading-relaxed focus:outline-none focus:border-[var(--pl-accent)] resize-y min-h-[340px]"
                  />
                ) : (
                  <pre className="p-4 bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg text-xs text-[var(--pl-text-secondary)] whitespace-pre-wrap font-sans leading-relaxed max-h-[520px] overflow-y-auto">
                    {transcriptText}
                  </pre>
                )}

                {auditResult &&
                  auditResult.flags.length > 0 &&
                  notesViewMode === "summary" && (
                    <p className="text-xs text-[var(--pl-text-muted)]">
                      Hover over any highlighted bullet to inspect the exact
                      transcript quote and timestamp.
                    </p>
                  )}
              </section>

              {/* Right Column: Audit Findings & Remediation Drafts */}
              <section className="lg:col-span-7 bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl p-5 flex flex-col gap-4">
                {auditError && (
                  <div className="bg-[var(--pl-danger-soft)] border border-[var(--pl-danger-border)] rounded-lg p-3.5 text-sm text-[var(--pl-danger-ink)]">
                    {auditError}
                  </div>
                )}

                {runningAudit ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--pl-accent)] mb-3" />
                    <p className="text-sm font-medium text-[var(--pl-text)]">
                      Checking call claims against {guardrails.length} approved
                      proof points...
                    </p>
                    <p className="text-xs text-[var(--pl-text-muted)] mt-1">
                      Matching summary bullets to transcript quotes via{" "}
                      <span className="font-mono">gemini-4-hydrogen</span>
                    </p>
                  </div>
                ) : !auditResult ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto">
                    <FileText className="w-6 h-6 text-[var(--pl-text-muted)] mb-3" />
                    <h2 className="text-sm font-semibold text-[var(--pl-text)]">
                      Ready to audit your Granola call
                    </h2>
                    <p className="text-xs text-[var(--pl-text-muted)] mt-1.5 leading-relaxed">
                      Click{" "}
                      <span className="font-medium text-[var(--pl-text)]">
                        Scan for Overclaims
                      </span>{" "}
                      to highlight stretched promises on the summary, inspect
                      transcript quotes on hover, and generate your client +
                      engineering drafts.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Executive Verdict */}
                    <div className="border-b border-[var(--pl-border)] pb-3.5 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5 text-xs font-medium tabular-nums">
                        <span
                          style={{ color: "var(--pl-danger-text)" }}
                          className="inline-flex items-center gap-1.5"
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                          {auditResult.flags.length} Overclaims Flagged
                        </span>
                        <span
                          aria-hidden="true"
                          className="text-[var(--pl-border-strong)]"
                        >
                          ·
                        </span>
                        <span
                          style={{ color: "var(--pl-accent-text)" }}
                          className="inline-flex items-center gap-1.5"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {auditResult.compliantClaims.length} Verified Compliant
                        </span>
                        <span
                          aria-hidden="true"
                          className="text-[var(--pl-border-strong)]"
                        >
                          ·
                        </span>
                        <span className="text-[var(--pl-text-muted)]">
                          {selectedFlagCount} included in repair drafts
                        </span>
                      </div>
                      <p className="text-[13.5px] text-[var(--pl-text)] font-medium leading-snug">
                        {auditResult.summary}
                      </p>
                    </div>

                    {/* Result Segmented Tabs */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-1 p-1 bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg w-fit">
                        <button
                          type="button"
                          onClick={() => setResultTab("flags")}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer ${
                            resultTab === "flags"
                              ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                              : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                          }`}
                        >
                          Audit Flags ({auditResult.flags.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setResultTab("email")}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer ${
                            resultTab === "email"
                              ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                              : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                          }`}
                        >
                          <Mail className="w-3.5 h-3.5" />
                          <span>Client Follow-Up</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setResultTab("brief")}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer ${
                            resultTab === "brief"
                              ? "bg-[var(--pl-surface)] text-[var(--pl-text)]"
                              : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                          }`}
                        >
                          <MessageSquareWarning className="w-3.5 h-3.5" />
                          <span>Engineering Heads-Up</span>
                        </button>
                      </div>

                      {redrafting && (
                        <span className="text-xs text-[var(--pl-text-muted)] inline-flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Updating drafts...
                        </span>
                      )}
                    </div>

                    {resultTab === "flags" && (
                      <div className="space-y-4">
                        {auditResult.flags.length === 0 ? (
                          <div
                            style={{
                              backgroundColor: "var(--pl-accent-soft)",
                              borderColor: "var(--pl-accent-border)",
                            }}
                            className="py-8 text-center border rounded-lg"
                          >
                            <ShieldCheck
                              style={{ color: "var(--pl-accent-text)" }}
                              className="w-6 h-6 mx-auto mb-2"
                            />
                            <p className="text-sm font-medium text-[var(--pl-text)]">
                              No overclaims detected against your Q4 2026
                              guardrails.
                            </p>
                          </div>
                        ) : (
                          <div className="divide-y divide-[var(--pl-border)] border border-[var(--pl-border)] rounded-lg overflow-hidden">
                            {auditResult.flags.map((flag, idx) => {
                              const isFocused = activeFlagIndex === idx;
                              const isIncluded = includedFlags[idx] !== false;
                              return (
                                <div
                                  key={idx}
                                  onClick={() => setActiveFlagIndex(idx)}
                                  className={`p-4 space-y-2.5 transition-colors cursor-pointer ${
                                    isFocused
                                      ? "bg-[var(--pl-surface-inset)]"
                                      : "hover:bg-[var(--pl-surface-inset)]"
                                  }`}
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex items-center gap-2 text-xs font-medium">
                                      <span
                                        style={{
                                          color:
                                            flag.severity === "HIGH"
                                              ? "var(--pl-danger-text)"
                                              : "var(--pl-warn-text)",
                                        }}
                                        className="inline-flex items-center gap-1 font-semibold"
                                      >
                                        <AlertTriangle className="w-3.5 h-3.5" />
                                        {flag.severity} Risk
                                      </span>
                                      <span
                                        aria-hidden="true"
                                        className="text-[var(--pl-border-strong)]"
                                      >
                                        ·
                                      </span>
                                      <span className="text-[var(--pl-text)] font-semibold">
                                        {flag.category}
                                      </span>
                                    </div>

                                    <div className="flex items-center gap-4">
                                      <label
                                        className="inline-flex items-center gap-1.5 text-xs text-[var(--pl-text-secondary)] cursor-pointer"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isIncluded}
                                          onChange={(e) => {
                                            const nextMap = {
                                              ...includedFlags,
                                              [idx]: e.target.checked,
                                            };
                                            setIncludedFlags(nextMap);
                                            void handleRedraft(
                                              draftTone,
                                              nextMap
                                            );
                                          }}
                                          className="rounded border-[var(--pl-border-strong)] accent-[var(--pl-accent)]"
                                        />
                                        <span>Include in follow-up</span>
                                      </label>

                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCopy(
                                            `walkback-${idx}`,
                                            flag.safeWalkBack
                                          );
                                        }}
                                        className="text-xs font-medium text-[var(--pl-text-muted)] hover:text-[var(--pl-text)] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                      >
                                        {copiedKey === `walkback-${idx}` ? (
                                          <>
                                            <Check
                                              style={{
                                                color: "var(--pl-accent-text)",
                                              }}
                                              className="w-3.5 h-3.5"
                                            />
                                            <span
                                              style={{
                                                color: "var(--pl-accent-text)",
                                              }}
                                            >
                                              Copied
                                            </span>
                                          </>
                                        ) : (
                                          <>
                                            <Copy className="w-3.5 h-3.5" />
                                            <span>Copy Safe Line</span>
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
                                    <div
                                      style={{
                                        backgroundColor:
                                          "var(--pl-danger-soft)",
                                        borderColor:
                                          "var(--pl-danger-border)",
                                      }}
                                      className="border rounded-lg p-3 space-y-1"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span
                                          style={{
                                            color: "var(--pl-danger-text)",
                                          }}
                                          className="font-semibold"
                                        >
                                          Said on Call
                                        </span>
                                        <span className="font-mono text-[var(--pl-text-muted)] text-[11px] tabular-nums">
                                          {flag.transcriptTimestamp}
                                        </span>
                                      </div>
                                      <p className="text-[var(--pl-text)] leading-relaxed">
                                        “{flag.transcriptQuote}”
                                      </p>
                                    </div>

                                    <div className="bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-lg p-3 space-y-1">
                                      <div className="font-semibold text-[var(--pl-text-secondary)]">
                                        Approved Proof Point
                                      </div>
                                      <p className="text-[var(--pl-text-secondary)] leading-relaxed">
                                        {flag.ruleViolated}
                                      </p>
                                    </div>
                                  </div>

                                  <div
                                    style={{
                                      backgroundColor: "var(--pl-accent-soft)",
                                      borderColor: "var(--pl-accent-border)",
                                    }}
                                    className="border rounded-lg p-3 text-xs space-y-1"
                                  >
                                    <div
                                      style={{
                                        color: "var(--pl-accent-text)",
                                      }}
                                      className="font-semibold"
                                    >
                                      What We Can Actually Say
                                    </div>
                                    <p className="text-[var(--pl-text)] leading-relaxed">
                                      {flag.safeWalkBack}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {auditResult.compliantClaims.length > 0 && (
                          <div className="pt-1">
                            <h3 className="text-xs font-semibold text-[var(--pl-text-muted)] mb-2">
                              Verified Compliant Statements
                            </h3>
                            <ul className="space-y-1.5 text-xs text-[var(--pl-text-secondary)]">
                              {auditResult.compliantClaims.map((c, i) => (
                                <li
                                  key={i}
                                  className="flex items-start gap-2 leading-relaxed"
                                >
                                  <CheckCircle2
                                    style={{ color: "var(--pl-accent-text)" }}
                                    className="w-3.5 h-3.5 shrink-0 mt-0.5"
                                  />
                                  <span>
                                    <strong className="text-[var(--pl-text)] font-medium">
                                      “{c.quote}”
                                    </strong>{" "}
                                    — {c.verifiedAgainst}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Client Clarification Email Card */}
                    {resultTab === "email" &&
                      (auditResult.clientFollowUpEmail ? (
                        <div className="border border-[var(--pl-border)] rounded-xl overflow-hidden bg-[var(--pl-surface)]">
                          <div className="bg-[var(--pl-surface-inset)] border-b border-[var(--pl-border)] px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--pl-text)]">
                              <Mail className="w-3.5 h-3.5 text-[var(--pl-text-muted)]" />
                              <span>Client Clarification Draft</span>
                            </div>

                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[var(--pl-text-muted)]">
                                Tone:
                              </span>
                              <div className="flex items-center gap-0.5 p-0.5 bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-md">
                                <button
                                  type="button"
                                  disabled={redrafting}
                                  onClick={() => void handleRedraft("warm")}
                                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                                    draftTone === "warm"
                                      ? "bg-[var(--pl-surface-inset)] text-[var(--pl-text)]"
                                      : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                                  }`}
                                >
                                  Warm
                                </button>
                                <button
                                  type="button"
                                  disabled={redrafting}
                                  onClick={() => void handleRedraft("direct")}
                                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                                    draftTone === "direct"
                                      ? "bg-[var(--pl-surface-inset)] text-[var(--pl-text)]"
                                      : "text-[var(--pl-text-muted)] hover:text-[var(--pl-text)]"
                                  }`}
                                >
                                  Direct
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="divide-y divide-[var(--pl-border)] text-xs sm:text-sm">
                            <div className="px-5 py-2.5 flex items-center gap-3">
                              <span className="text-xs font-medium text-[var(--pl-text-muted)] w-14">
                                To
                              </span>
                              <span className="text-[var(--pl-text)] font-medium">
                                {auditResult.prospectContact ||
                                  "Prospect Stakeholder"}
                              </span>
                            </div>
                            <div className="px-5 py-2.5 flex items-center gap-3">
                              <span className="text-xs font-medium text-[var(--pl-text-muted)] w-14">
                                Subject
                              </span>
                              <span className="text-[var(--pl-text)] font-semibold">
                                {auditResult.clientFollowUpEmail.subject}
                              </span>
                            </div>
                          </div>

                          <div className="p-5 border-t border-[var(--pl-border)]">
                            <pre className="text-[13.5px] text-[var(--pl-text-secondary)] whitespace-pre-wrap font-sans leading-relaxed">
                              {auditResult.clientFollowUpEmail.body}
                            </pre>
                          </div>

                          <div className="bg-[var(--pl-surface-inset)] border-t border-[var(--pl-border)] px-5 py-3 flex items-center justify-between gap-4">
                            <span className="text-xs text-[var(--pl-text-muted)] tabular-nums">
                              Walks back {selectedFlagCount} flagged{" "}
                              {selectedFlagCount === 1 ? "claim" : "claims"}
                            </span>

                            <div className="flex items-center gap-2">
                              <a
                                href={`mailto:?subject=${encodeURIComponent(
                                  auditResult.clientFollowUpEmail.subject
                                )}&body=${encodeURIComponent(
                                  auditResult.clientFollowUpEmail.body
                                )}`}
                                className="h-8 px-3 text-xs font-medium text-[var(--pl-text)] bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-lg hover:bg-[var(--pl-surface-hover)] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                              >
                                <Send className="w-3.5 h-3.5" />
                                <span>Open in Mail</span>
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopy(
                                    "client-email",
                                    `Subject: ${auditResult.clientFollowUpEmail!.subject}\n\n${auditResult.clientFollowUpEmail!.body}`
                                  )
                                }
                                className="h-8 px-3.5 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {copiedKey === "client-email" ? (
                                  <Check className="w-3.5 h-3.5" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {copiedKey === "client-email"
                                    ? "Copied Draft"
                                    : "Copy Email"}
                                </span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="border border-[var(--pl-border)] rounded-xl p-10 text-center text-xs text-[var(--pl-text-muted)] flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-[var(--pl-accent)]" />
                          <span>Drafting client follow-up email...</span>
                        </div>
                      ))}

                    {/* Slack Channel Heads-Up Card */}
                    {resultTab === "brief" &&
                      (auditResult.internalTeamBrief ? (
                        <div className="border border-[var(--pl-border)] rounded-xl overflow-hidden bg-[var(--pl-surface)]">
                          <div
                            style={{
                              backgroundColor: "var(--pl-slack-header)",
                              color: "var(--pl-slack-header-text)",
                            }}
                            className="px-5 py-3 flex items-center justify-between gap-4 border-b border-[var(--pl-border)]"
                          >
                            <div className="flex items-center gap-2 text-xs font-medium">
                              <Hash
                                style={{ color: "var(--pl-accent-text)" }}
                                className="w-3.5 h-3.5"
                              />
                              <span>eng-deal-desk</span>
                              <span
                                aria-hidden="true"
                                className="opacity-40"
                              >
                                ·
                              </span>
                              <span className="opacity-75">
                                Internal Engineering & InfoSec Heads-Up
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                handleCopy(
                                  "internal-brief",
                                  `${auditResult.internalTeamBrief!.title}\n\n${auditResult.internalTeamBrief!.body}`
                                )
                              }
                              className="h-7 px-2.5 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-md hover:bg-[var(--pl-accent-hover)] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {copiedKey === "internal-brief" ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              <span>
                                {copiedKey === "internal-brief"
                                  ? "Copied Slack Post"
                                  : "Copy Slack Update"}
                              </span>
                            </button>
                          </div>

                          <div className="p-5 flex items-start gap-3.5">
                            <div className="pt-0.5 shrink-0">
                              <ProoflineLogo size={28} />
                            </div>
                            <div className="space-y-2 min-w-0 flex-1">
                              <div className="flex items-baseline gap-2">
                                <span className="text-sm font-semibold text-[var(--pl-text)]">
                                  Proofline
                                </span>
                                <span className="text-xs text-[var(--pl-text-muted)] tabular-nums">
                                  Just now
                                </span>
                              </div>
                              <div className="text-sm font-semibold text-[var(--pl-text)]">
                                {auditResult.internalTeamBrief.title}
                              </div>
                              <pre className="text-[13.5px] text-[var(--pl-text-secondary)] whitespace-pre-wrap font-sans leading-relaxed">
                                {auditResult.internalTeamBrief.body}
                              </pre>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="border border-[var(--pl-border)] rounded-xl p-10 text-center text-xs text-[var(--pl-text-muted)] flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-[var(--pl-accent)]" />
                          <span>Drafting engineering Slack update...</span>
                        </div>
                      ))}
                  </>
                )}
              </section>
            </div>
          </div>
        )}

        {activeView === "guardrails" && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold text-[var(--pl-text)] tracking-[-0.02em]">
                  Approved Proof Points & Boundaries (Q4 2026)
                </h1>
                <p className="text-xs text-[var(--pl-text-muted)] mt-0.5">
                  Source of truth used by Gemini to detect overclaims in your
                  Granola calls.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setGuardrails(DEFAULT_GUARDRAILS)}
                  className="h-9 px-3.5 text-xs font-medium text-[var(--pl-text)] bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-lg hover:bg-[var(--pl-surface-hover)] transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Defaults</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setGuardrails((prev) => [
                      ...prev,
                      {
                        id: `rule-${Date.now()}`,
                        category: "New Guardrail",
                        approved: "",
                        boundary: "",
                      },
                    ])
                  }
                  className="h-9 px-4 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Rule</span>
                </button>
              </div>
            </div>

            <div className="bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl overflow-hidden">
              <div className="divide-y divide-[var(--pl-border)]">
                {guardrails.map((rule, idx) => (
                  <div
                    key={rule.id}
                    className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-4 items-start"
                  >
                    <div className="lg:col-span-3 flex items-center gap-2">
                      <span className="font-mono text-xs text-[var(--pl-text-muted)] tabular-nums w-5">
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      <input
                        type="text"
                        value={rule.category}
                        onChange={(e) =>
                          setGuardrails((prev) =>
                            prev.map((r) =>
                              r.id === rule.id
                                ? { ...r, category: e.target.value }
                                : r
                            )
                          )
                        }
                        className="w-full h-9 px-3 text-xs font-semibold text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)]"
                      />
                    </div>

                    <div className="lg:col-span-4">
                      <label
                        style={{ color: "var(--pl-accent-text)" }}
                        className="text-xs font-semibold block mb-1.5"
                      >
                        Approved (Safe to Say)
                      </label>
                      <textarea
                        rows={2}
                        value={rule.approved}
                        onChange={(e) =>
                          setGuardrails((prev) =>
                            prev.map((r) =>
                              r.id === rule.id
                                ? { ...r, approved: e.target.value }
                                : r
                            )
                          )
                        }
                        className="w-full p-2.5 text-xs text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)]"
                      />
                    </div>

                    <div className="lg:col-span-4">
                      <label
                        style={{ color: "var(--pl-danger-text)" }}
                        className="text-xs font-semibold block mb-1.5"
                      >
                        Do Not Promise (Boundary)
                      </label>
                      <textarea
                        rows={2}
                        value={rule.boundary}
                        onChange={(e) =>
                          setGuardrails((prev) =>
                            prev.map((r) =>
                              r.id === rule.id
                                ? { ...r, boundary: e.target.value }
                                : r
                            )
                          )
                        }
                        className="w-full p-2.5 text-xs text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)]"
                      />
                    </div>

                    <div className="lg:col-span-1 flex lg:justify-end pt-5">
                      <button
                        type="button"
                        onClick={() =>
                          setGuardrails((prev) =>
                            prev.filter((r) => r.id !== rule.id)
                          )
                        }
                        className="p-2 text-[var(--pl-text-muted)] hover:text-[var(--pl-danger-text)] transition-colors cursor-pointer"
                        title="Remove guardrail"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeView === "explorer" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold text-[var(--pl-text)] tracking-[-0.02em]">
                  Granola MCP Tool Explorer
                </h1>
                <p className="text-xs text-[var(--pl-text-muted)] mt-0.5">
                  Direct Streamable HTTP connection to{" "}
                  <span className="font-mono text-[var(--pl-text-secondary)]">
                    https://mcp.granola.ai/mcp
                  </span>
                </p>
              </div>
              {isConnected && (
                <button
                  type="button"
                  onClick={() => void fetchStatus(true)}
                  className="h-9 px-3.5 text-xs font-medium text-[var(--pl-text)] bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-lg hover:bg-[var(--pl-surface-hover)] inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh Tools</span>
                </button>
              )}
            </div>

            {!isConnected ? (
              <div className="bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl p-8 max-w-xl">
                <p className="text-sm text-[var(--pl-text-secondary)]">
                  Connect your Granola account to inspect and invoke live MCP
                  tools exposed by{" "}
                  <span className="font-mono text-[var(--pl-text)]">
                    https://mcp.granola.ai/mcp
                  </span>
                  .
                </p>
                <button
                  type="button"
                  onClick={handleConnect}
                  className="mt-4 h-9 px-4 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] inline-flex items-center gap-2 cursor-pointer"
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>Connect Granola</span>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
                <section className="xl:col-span-4 bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--pl-border)] flex items-center gap-2">
                    <Wrench className="w-3.5 h-3.5 text-[var(--pl-text-muted)]" />
                    <span className="text-xs font-semibold text-[var(--pl-text-muted)] tabular-nums">
                      Available Tools ({status?.tools.length ?? 0})
                    </span>
                  </div>
                  <ul className="divide-y divide-[var(--pl-border)]">
                    {(status?.tools ?? []).map((tool) => (
                      <li key={tool.name}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedToolName(tool.name);
                            setToolArgsJson(buildDefaultToolArgs(tool));
                            setToolOutput("");
                            setToolCallError(null);
                          }}
                          style={{
                            backgroundColor:
                              selectedToolName === tool.name
                                ? "var(--pl-accent-soft)"
                                : undefined,
                          }}
                          className="w-full text-left px-4 py-3 transition-colors hover:bg-[var(--pl-surface-inset)] cursor-pointer"
                        >
                          <div className="font-mono text-xs font-semibold text-[var(--pl-text)]">
                            {tool.name}
                          </div>
                          {tool.description && (
                            <p className="text-xs text-[var(--pl-text-muted)] mt-1 line-clamp-2">
                              {tool.description}
                            </p>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="xl:col-span-8 bg-[var(--pl-surface)] border border-[var(--pl-border)] rounded-xl p-6 space-y-5">
                  {activeTool ? (
                    <>
                      <div className="border-b border-[var(--pl-border)] pb-4">
                        <h2 className="font-mono text-base font-semibold text-[var(--pl-text)]">
                          {activeTool.name}
                        </h2>
                        {activeTool.description && (
                          <p className="text-xs text-[var(--pl-text-secondary)] mt-1">
                            {activeTool.description}
                          </p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor="mcp-args"
                          className="text-xs font-semibold text-[var(--pl-text-muted)] block mb-2"
                        >
                          Arguments (JSON)
                        </label>
                        <textarea
                          id="mcp-args"
                          rows={6}
                          value={toolArgsJson}
                          onChange={(e) => setToolArgsJson(e.target.value)}
                          className="w-full p-3 font-mono text-xs text-[var(--pl-text)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg focus:outline-none focus:border-[var(--pl-accent)]"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs text-[var(--pl-text-muted)]">
                          Calls <span className="font-mono">tools/call</span> on
                          Granola MCP
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRunExplorerTool()}
                          disabled={runningTool}
                          className="h-9 px-4 text-xs font-medium text-[var(--pl-accent-ink)] bg-[var(--pl-accent)] rounded-lg hover:bg-[var(--pl-accent-hover)] disabled:opacity-60 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {runningTool ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Terminal className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {runningTool ? "Calling..." : "Invoke Tool"}
                          </span>
                        </button>
                      </div>

                      {toolCallError && (
                        <div className="bg-[var(--pl-danger-soft)] border border-[var(--pl-danger-border)] rounded-lg p-3 text-sm text-[var(--pl-danger-ink)]">
                          {toolCallError}
                        </div>
                      )}

                      {toolOutput && (
                        <div className="border-t border-[var(--pl-border)] pt-4">
                          <h3 className="text-xs font-semibold text-[var(--pl-text-muted)] mb-2">
                            Response
                          </h3>
                          <pre className="text-xs font-mono text-[var(--pl-text-secondary)] bg-[var(--pl-surface-inset)] border border-[var(--pl-border)] rounded-lg p-4 whitespace-pre-wrap max-h-[420px] overflow-y-auto">
                            {toolOutput}
                          </pre>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-[var(--pl-text-muted)]">
                      Select an MCP tool from the left to inspect and invoke it.
                    </p>
                  )}
                </section>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
