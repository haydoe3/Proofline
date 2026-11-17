# Proofline

**Post-Call Overclaim Checker for GTM & Sales Teams**

> *Granola captures what was said; Gemini protects what you commit to.*

Proofline connects directly to your [Granola](https://granola.ai) call notes and transcripts via **Granola MCP** (or any public `notes.granola.ai` share link) and audits sales commitments against your company’s **Approved Proof Points & Boundaries** using **Gemini** (`gemini-4-hydrogen`).

Instead of manually digging through transcripts after a fast discovery call, Proofline highlights stretched claims directly on the call summary, links each bullet to the exact spoken quote and timestamp on hover, and drafts both a client clarification email and an internal Engineering/InfoSec heads-up.

---

## Key Features

- **Granola MCP Sync (OAuth 2.0 + PKCE + DCR)**: Connects directly to `https://mcp.granola.ai/mcp` via Streamable HTTP (`list_meetings`, `get_meetings`, `get_meeting_transcript`) and includes a live **MCP Explorer** tab.
- **One-Click Share Link Import**: Paste any public `notes.granola.ai/t/...` share link to load structured bullet-point summaries immediately.
- **Two-Stage Overclaim Audit (`gemini-4-hydrogen`)**:
  - **Stage 1 (Flags & Inline Highlights)**: Audits call claims against 6 editable Q4 2026 guardrails (Speed & Latency, Benchmark, Timeline, Security & Hosting, Integrations, SLA & Commercial), highlights flagged summary bullets in red, and displays a hover **Transcript Evidence** popover with the verbatim quote and timestamp.
  - **Stage 2 (Remediation Drafts)**: Automatically generates:
    - **Client Clarification Email** (`Warm` / `Direct` tone toggle, selective claim checkboxes, `Open in Mail`, `Copy Email`)
    - **Internal `#eng-deal-desk` Slack Heads-Up** (`Copy Slack Update`)
- **Editable Guardrails**: Customize, add, or reset your approved claims and hard boundaries in the **Guardrails** tab.
- **4 Workspace Palettes**: Switch inline between **Obsidian**, **Alabaster**, **Cobalt**, and **Carbon** themes.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide Icons
- **Backend**: Node.js 22+, Express (`server.ts`), Streamable HTTP MCP client, OAuth 2.0 + PKCE
- **AI**: `@google/genai` (`gemini-4-hydrogen`, server-side only via `/api/gemini/audit` and `/api/gemini/redraft`)

---

## Local Setup

### Prerequisites
- **Node.js 22+** (required for `npm start` native TypeScript execution and runtime support)
- A **Gemini API Key** from Google AI Studio

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and add your Gemini API key:
```bash
cp .env.example .env
```

```env
GEMINI_API_KEY="your_gemini_api_key"
APP_URL="http://localhost:3000"
```

### 3. Run in Development
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### 4. Production Build & Start
```bash
npm run build
npm start
```

---

## Project Structure

- `server.ts` — Express server serving Vite in dev / `dist/` in production, Granola MCP OAuth 2.0 + PKCE + Streamable HTTP proxy, share link parser, and Gemini audit/redraft API routes
- `src/App.tsx` — Main Proofline workspace (Overclaim Audit, Guardrails Editor, MCP Explorer, interactive transcript evidence tooltips, and inline palette switcher)
- `src/index.css` — Theme CSS variables for Obsidian, Alabaster, Cobalt, and Carbon palettes
- `public/assets/` — Approved Proof Points & Boundaries reference document
