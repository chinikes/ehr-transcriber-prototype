# EHR-Transcriber Integration — UiPath SOC Automation Prototype

Interactive simulation dashboard for an **EHR-Transcriber SOC (Start of Care) Integration** powered by UiPath automation.

This prototype visualizes the full end-to-end workflow covering both Phase A (Visit Extract) and Phase D (OASIS Writeback), with an AI Assistant processing phase shown for context in between.

## What It Does

The dashboard lets you simulate the two UiPath bots step-by-step:

**Phase A — Visit Extract** (EMR → UiPath → Message Queue)
1. Authenticate to EMR
2. Navigate to Visit Schedule Report
3. Export report as CSV
4. Parse & validate CSV data
5. Push validated records to message queue

**Phases B & C — AI Assistant Processing** (shown for context, out of UiPath scope)

**Phase D — OASIS Writeback** (Orchestrator Queue → UiPath → EMR)
6. Receive item from Orchestrator Queue
7. Authenticate to EMR
8. Locate patient episode
9. Map & populate OASIS fields

### Features

- **Step-by-step simulation** with real-time status updates and execution logs
- **Error scenario injection** — test auth failures, empty reports, validation errors, queue timeouts, missing episodes, and already-approved episodes
- **Speed control** — run at slow, normal, fast, or instant speed
- **Queue message visualization** — see JSON payloads as they're published
- **OASIS field population** — watch fields fill in one-by-one with a progress bar
- **Parsed CSV data table** — view the 8 required fields per visit
- **Configuration panel** — shows credential storage, retry policies, timeouts
- **Open blockers** — surfaces unresolved dependencies (Visit ID, Clinician ID, OASIS mapping)

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

## Tech Stack

- **React 18** — UI components
- **Vite 6** — Build tool and dev server
- **Tailwind CSS 3** — Utility-first styling

## Project Structure

```
src/
  App.jsx       # Main dashboard component with simulation engine
  main.jsx      # React entry point
  index.css     # Tailwind imports
```

## License

MIT
