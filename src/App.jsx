import { useState, useEffect, useCallback, useRef } from "react";

// --- Mock Data ---
const MOCK_VISITS = [
  { patient_first_name: "Margaret", patient_last_name: "Chen", patient_id: "MRN-10042", clinician_id: "RN-Phillips", visit_id: "V-88401", visit_type: "SOC", visit_date: "2026-03-25", visit_start_time: "09:00" },
  { patient_first_name: "Robert", patient_last_name: "Williams", patient_id: "MRN-10087", clinician_id: "PT-Alvarez", visit_id: "V-88402", visit_type: "SOC", visit_date: "2026-03-25", visit_start_time: "10:30" },
  { patient_first_name: "Dorothy", patient_last_name: "Baker", patient_id: "MRN-10103", clinician_id: "OT-Johnson", visit_id: "V-88403", visit_type: "SOC", visit_date: "2026-03-25", visit_start_time: "13:00" },
  { patient_first_name: "James", patient_last_name: "Martinez", patient_id: "MRN-10055", clinician_id: "RN-Thompson", visit_id: "V-88404", visit_type: "SOC", visit_date: "2026-03-25", visit_start_time: "14:15" },
  { patient_first_name: "Helen", patient_last_name: "Davis", patient_id: "MRN-10091", clinician_id: "ST-Park", visit_id: "V-88405", visit_type: "SOC", visit_date: "2026-03-25", visit_start_time: "15:45" },
];

const MOCK_OASIS_ANSWERS = {
  "M1800": "03", "M1810": "01", "M1820": "02", "M1830": "03",
  "M1840": "01", "M1850": "02", "M1860": "01", "M1033": "02",
  "M1034": "01", "M1036": "00", "M1100": "03", "M1200": "02",
  "M1242": "01", "M1306": "02", "M1307": "01", "M1308": "03",
  "M1309": "00", "M1322": "01", "M1324": "02", "M1330": "01",
};

const ERROR_SCENARIOS = {
  auth_fail: { step: 1, message: "EMR login failed - invalid credentials (retry 1/3)", recovery: "Retrying with 10s delay..." },
  empty_report: { step: 3, message: "CSV export contains 0 data rows (header only)", recovery: "No SOC visits today. Ending run gracefully." },
  validation_fail: { step: 4, message: "Row 3: patient_id is null. Row skipped.", recovery: "Failed row logged to EMR_SOC_Errors_20260325.csv" },
  sqs_fail: { step: 5, message: "SQS publish timeout after 30s", recovery: "Business Rule Exception raised. Admin notified." },
  episode_not_found: { step: 8, message: "MRN-10042: No active SOC episode found", recovery: "Queue item flagged as Failed. Skipping to next." },
  already_approved: { step: 8, message: "MRN-10087: Episode already approved", recovery: "Cannot reopen. Logged and skipped." },
};

// --- Phase Definitions ---
const PHASE_A_STEPS = [
  { id: 1, name: "Authenticate to EMR", icon: "\u{1F510}", detail: "Launch browser session, retrieve credentials from Orchestrator Asset Store, verify dashboard loads. Retry 3x on failure.", system: "UiPath \u2192 EMR" },
  { id: 2, name: "Navigate to Visit Schedule Report", icon: "\u{1F4CB}", detail: "Reports Admin \u2192 Schedule Report. Filter: Visit Type=SOC, Discipline=RN/PT/OT/ST, Date=Today.", system: "UiPath \u2192 EMR" },
  { id: 3, name: "Export Report as CSV", icon: "\u{1F4E5}", detail: "Trigger export, monitor Downloads folder (60s timeout). Rename: EMR_SOC_Schedule_YYYYMMDD_HHMMSS.csv", system: "UiPath \u2192 EMR" },
  { id: 4, name: "Parse & Validate CSV", icon: "\u{1F50D}", detail: "Read CSV into DataTable. Validate 8 required fields per row. Flag invalid rows to error log.", system: "UiPath" },
  { id: 5, name: "Push to Message Queue", icon: "\u{1F4E4}", detail: "Publish validated visit records to the message queue. One message per visit row. Phase A complete.", system: "UiPath \u2192 Message Queue" },
];

const PHASE_D_STEPS = [
  { id: 6, name: "Receive from Orchestrator Queue", icon: "\u{1F4E8}", detail: "Triggered by new queue item. Contains MRN, Visit ID, all AI-extracted OASIS answers from the AI Assistant.", system: "Orchestrator \u2192 UiPath" },
  { id: 7, name: "Authenticate to EMR", icon: "\u{1F510}", detail: "Same auth logic as Phase A. Credentials from Orchestrator Asset Store. Retry 3x with 15s delay.", system: "UiPath \u2192 EMR" },
  { id: 8, name: "Locate Patient Episode", icon: "\u{1F50E}", detail: "Search EMR by MRN. Verify active SOC episode exists and is open. Skip if not found/approved.", system: "UiPath \u2192 EMR" },
  { id: 9, name: "Map & Populate OASIS Fields", icon: "\u270F\uFE0F", detail: "Navigate OASIS form page-by-page. Enter AI answers via Type Into/Select Item. Save each page. STOP before Approve.", system: "UiPath \u2192 EMR" },
];

const AI_ASSISTANT_STEPS = [
  { id: "B1", name: "AI Assistant consumes message", icon: "\u{1F4F1}", detail: "SOC visit appears in clinician's mobile app" },
  { id: "B2", name: "Clinician conducts SOC visit", icon: "\u{1F3E5}", detail: "Clock in via EVV, conduct interview, record in mobile app" },
  { id: "B3", name: "AI generates OASIS responses", icon: "\u{1F916}", detail: "Full transcript, AI-extracted OASIS responses, reasoning" },
  { id: "B4", name: "Clinician review & submit", icon: "\u2705", detail: "Review answers, submit to 'Submitted to EMR'" },
  { id: "B5", name: "Admin reviews in Portal", icon: "\u{1F464}", detail: "Agency Admin reviews OASIS; portal order matches EMR sequence" },
  { id: "B6", name: "QN completes Goals & Interventions", icon: "\u{1F4DD}", detail: "Quality Nurse manually enters (never automated)" },
  { id: "B7", name: "Push to Orchestrator Queue", icon: "\u{1F4E4}", detail: "Completed OASIS data triggers Phase D bot" },
];

// --- Utility Components ---
function Badge({ children, color }) {
  const colors = {
    green: "bg-emerald-100 text-emerald-800 border-emerald-200",
    blue: "bg-blue-100 text-blue-800 border-blue-200",
    amber: "bg-amber-100 text-amber-800 border-amber-200",
    red: "bg-red-100 text-red-800 border-red-200",
    gray: "bg-gray-100 text-gray-600 border-gray-200",
    purple: "bg-purple-100 text-purple-800 border-purple-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
}

function ProgressBar({ value, max, color = "bg-emerald-500" }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- Step Card ---
function StepCard({ step, status, isActive, error, logs, onClick }) {
  const statusStyles = {
    pending: "border-gray-200 bg-white",
    running: "border-blue-400 bg-blue-50 shadow-md shadow-blue-100 ring-2 ring-blue-200",
    success: "border-emerald-300 bg-emerald-50",
    error: "border-red-300 bg-red-50",
    skipped: "border-gray-200 bg-gray-50 opacity-60",
  };

  const statusIcons = {
    pending: "\u25CB",
    running: "\u25C9",
    success: "\u2713",
    error: "\u2717",
    skipped: "\u2014",
  };

  const statusColors = {
    pending: "text-gray-400",
    running: "text-blue-600",
    success: "text-emerald-600",
    error: "text-red-600",
    skipped: "text-gray-400",
  };

  return (
    <div
      className={`border rounded-lg p-4 transition-all duration-300 cursor-pointer hover:shadow-md ${statusStyles[status]}`}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-2xl">{step.icon}</span>
          <span className={`text-lg font-bold ${statusColors[status]}`}>{statusIcons[status]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-gray-400">Step {step.id}</span>
            {step.system && <Badge color="blue">{step.system}</Badge>}
          </div>
          <h4 className="font-semibold text-gray-900 text-sm">{step.name}</h4>
          <p className="text-xs text-gray-500 mt-1">{step.detail}</p>

          {status === "running" && (
            <div className="mt-2 flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-blue-600 font-medium">Processing...</span>
            </div>
          )}

          {error && (
            <div className="mt-2 p-2 bg-red-100 border border-red-200 rounded text-xs">
              <p className="font-medium text-red-700">{error.message}</p>
              <p className="text-red-600 mt-1">{error.recovery}</p>
            </div>
          )}

          {logs && logs.length > 0 && (
            <div className="mt-2 p-2 bg-gray-900 rounded text-xs font-mono text-green-400 max-h-24 overflow-y-auto">
              {logs.map((log, i) => <div key={i}>{log}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- AI Assistant Phase (Out of Scope visual) ---
function AiAssistantPhase({ status }) {
  const isComplete = status === "complete";
  const isActive = status === "active";

  return (
    <div className={`border-2 border-dashed rounded-xl p-4 transition-all duration-300 ${
      isActive ? "border-purple-400 bg-purple-50" : isComplete ? "border-gray-300 bg-gray-50" : "border-gray-200 bg-white"
    }`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{"\u{1F4F1}"}</span>
        <h3 className="font-bold text-gray-700">Phases B & C: AI Assistant Processing</h3>
        <Badge color="purple">Out of UiPath Scope</Badge>
        {isActive && <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />}
        {isComplete && <span className="text-emerald-600 font-bold">{"\u2713"}</span>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {AI_ASSISTANT_STEPS.map((s, i) => (
          <div key={s.id} className={`flex items-start gap-2 p-2 rounded text-xs ${
            isComplete ? "bg-gray-100" : isActive && i <= 3 ? "bg-purple-100" : "bg-white border border-gray-100"
          }`}>
            <span>{s.icon}</span>
            <div>
              <p className="font-medium text-gray-700">{s.name}</p>
              <p className="text-gray-500">{s.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Data Table ---
function DataTable({ data, title, columns }) {
  if (!data || data.length === 0) return null;
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
        <h4 className="text-sm font-semibold text-gray-700">{title}</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50">
              {columns.map(col => (
                <th key={col.key} className="px-3 py-2 text-left font-medium text-gray-600 border-b">{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i} className={`${i % 2 === 0 ? "bg-white" : "bg-gray-50"} hover:bg-blue-50`}>
                {columns.map(col => (
                  <td key={col.key} className="px-3 py-2 font-mono text-gray-700 border-b border-gray-100">
                    {row[col.key] || "\u2014"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- SQS Message Visualizer ---
function QueueMessage({ visit, index, isAnimating }) {
  return (
    <div className={`border border-amber-200 bg-amber-50 rounded p-2 text-xs font-mono transition-all duration-500 ${
      isAnimating ? "translate-x-0 opacity-100" : "-translate-x-4 opacity-0"
    }`}>
      <div className="text-amber-800 font-semibold mb-1">Queue Message #{index + 1}</div>
      <pre className="text-amber-700 whitespace-pre-wrap">
{JSON.stringify({
  patient_id: visit.patient_id,
  patient_name: `${visit.patient_first_name} ${visit.patient_last_name}`,
  visit_id: visit.visit_id,
  visit_date: visit.visit_date,
  visit_start_time: visit.visit_start_time,
}, null, 2)}
      </pre>
    </div>
  );
}

// --- OASIS Field Visualizer ---
function OasisFields({ fields, filledCount }) {
  const entries = Object.entries(fields);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-3 py-2 border-b">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-700">OASIS Field Mapping</h4>
          <Badge color={filledCount === entries.length ? "green" : "blue"}>
            {filledCount}/{entries.length} populated
          </Badge>
        </div>
        <ProgressBar value={filledCount} max={entries.length} />
      </div>
      <div className="grid grid-cols-4 gap-1 p-2">
        {entries.map(([key, val], i) => (
          <div key={key} className={`px-2 py-1 rounded text-xs font-mono transition-all duration-300 ${
            i < filledCount ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-400"
          }`}>
            <span className="font-semibold">{key}:</span> {i < filledCount ? val : "..."}
          </div>
        ))}
      </div>
      <div className="px-3 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-700">
        {"\u26A0"} Skipped: Goals & Interventions (manual QN), 485 Order (manual QN), Wounds/Photos
      </div>
    </div>
  );
}

// --- Main App ---
export default function SocAutomationPrototype() {
  const [simState, setSimState] = useState("idle"); // idle, running_a, ai_assistant, running_d, complete
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatuses, setStepStatuses] = useState({});
  const [stepLogs, setStepLogs] = useState({});
  const [stepErrors, setStepErrors] = useState({});
  const [selectedStep, setSelectedStep] = useState(null);
  const [queueMessages, setQueueMessages] = useState([]);
  const [oasisFilled, setOasisFilled] = useState(0);
  const [speed, setSpeed] = useState(1500);
  const [errorMode, setErrorMode] = useState("none");
  const [activeVisit, setActiveVisit] = useState(0);
  const [eventLog, setEventLog] = useState([]);
  const timerRef = useRef(null);

  const addLog = useCallback((step, msg) => {
    setStepLogs(prev => ({
      ...prev,
      [step]: [...(prev[step] || []), `[${new Date().toLocaleTimeString()}] ${msg}`]
    }));
    setEventLog(prev => [`[Step ${step}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const runStep = useCallback((stepId) => {
    setStepStatuses(prev => ({ ...prev, [stepId]: "running" }));
    setCurrentStep(stepId);
  }, []);

  const completeStep = useCallback((stepId, error = null) => {
    if (error) {
      setStepStatuses(prev => ({ ...prev, [stepId]: "error" }));
      setStepErrors(prev => ({ ...prev, [stepId]: error }));
    } else {
      setStepStatuses(prev => ({ ...prev, [stepId]: "success" }));
    }
  }, []);

  // Simulation engine
  useEffect(() => {
    if (simState === "idle" || simState === "complete") return;

    const runSim = async () => {
      const delay = (ms) => new Promise(r => { timerRef.current = setTimeout(r, ms); });

      if (simState === "running_a") {
        // Step 1: Auth
        runStep(1);
        addLog(1, "Launching EMR browser session...");
        await delay(speed);
        if (errorMode === "auth_fail") {
          addLog(1, "Login failed. Retry 1/3...");
          await delay(speed * 0.5);
          addLog(1, "Retry 2/3...");
          await delay(speed * 0.5);
          addLog(1, "Retry 3/3... Success");
        }
        addLog(1, "Credentials retrieved from Orchestrator Asset Store");
        addLog(1, "Dashboard element verified. Login successful.");
        completeStep(1);
        await delay(speed * 0.3);

        // Step 2: Navigate
        runStep(2);
        addLog(2, "Navigating to Reports Admin > Schedule Report...");
        await delay(speed);
        addLog(2, "Applying filters: Visit Type=SOC, Discipline=RN/PT/OT/ST, Date=2026-03-25");
        await delay(speed * 0.5);
        addLog(2, "Filters applied and validated.");
        completeStep(2);
        await delay(speed * 0.3);

        // Step 3: Export
        runStep(3);
        addLog(3, "Triggering CSV export...");
        await delay(speed);
        if (errorMode === "empty_report") {
          addLog(3, "File downloaded: 0 data rows (header only)");
          completeStep(3, ERROR_SCENARIOS.empty_report);
          setSimState("complete");
          return;
        }
        addLog(3, `File downloaded: EMR_SOC_Schedule_20260325_${new Date().toLocaleTimeString().replace(/:/g, "")}.csv`);
        addLog(3, `${MOCK_VISITS.length} rows detected. Moving to staging folder.`);
        completeStep(3);
        await delay(speed * 0.3);

        // Step 4: Parse & Validate
        runStep(4);
        addLog(4, "Reading CSV into DataTable...");
        await delay(speed * 0.5);
        for (let i = 0; i < MOCK_VISITS.length; i++) {
          const v = MOCK_VISITS[i];
          await delay(speed * 0.3);
          if (errorMode === "validation_fail" && i === 2) {
            addLog(4, `Row ${i + 1}: VALIDATION FAILED - patient_id is null. Flagged.`);
          } else {
            addLog(4, `Row ${i + 1}: ${v.patient_first_name} ${v.patient_last_name} (${v.patient_id}) \u2713`);
          }
        }
        const validCount = errorMode === "validation_fail" ? MOCK_VISITS.length - 1 : MOCK_VISITS.length;
        addLog(4, `Validation complete: ${validCount}/${MOCK_VISITS.length} rows valid.`);
        if (errorMode === "validation_fail") {
          addLog(4, "1 row written to EMR_SOC_Errors_20260325.csv");
        }
        completeStep(4);
        await delay(speed * 0.3);

        // Step 5: Push to Queue
        runStep(5);
        addLog(5, "Publishing to message queue...");
        const visitsToSend = errorMode === "validation_fail"
          ? MOCK_VISITS.filter((_, i) => i !== 2)
          : MOCK_VISITS;
        for (let i = 0; i < visitsToSend.length; i++) {
          await delay(speed * 0.4);
          if (errorMode === "sqs_fail" && i === 2) {
            addLog(5, `Message ${i + 1}: SEND FAILED - timeout after 30s`);
            completeStep(5, ERROR_SCENARIOS.sqs_fail);
            setSimState("complete");
            return;
          }
          addLog(5, `Message ${i + 1}/${visitsToSend.length} published: ${visitsToSend[i].visit_id}`);
          setQueueMessages(prev => [...prev, visitsToSend[i]]);
        }
        addLog(5, `Phase A complete. ${visitsToSend.length} messages in queue.`);
        completeStep(5);
        await delay(speed);
        setSimState("ai_assistant");
      }

      if (simState === "ai_assistant") {
        addLog("ai_assistant", "AI Assistant processing visits... (simulated)");
        await delay(speed * 2);
        setSimState("running_d");
      }

      if (simState === "running_d") {
        // Step 6: Receive from Queue
        runStep(6);
        addLog(6, "Polling Orchestrator Queue...");
        await delay(speed);
        addLog(6, `Queue item received: MRN=${MOCK_VISITS[activeVisit].patient_id}, Visit=${MOCK_VISITS[activeVisit].visit_id}`);
        addLog(6, `OASIS answers payload: ${Object.keys(MOCK_OASIS_ANSWERS).length} fields`);
        completeStep(6);
        await delay(speed * 0.3);

        // Step 7: Auth
        runStep(7);
        addLog(7, "Opening EMR browser session...");
        await delay(speed);
        addLog(7, "Credentials retrieved. Login verified.");
        completeStep(7);
        await delay(speed * 0.3);

        // Step 8: Locate Patient
        runStep(8);
        addLog(8, `Searching EMR for MRN: ${MOCK_VISITS[activeVisit].patient_id}...`);
        await delay(speed);
        if (errorMode === "episode_not_found") {
          addLog(8, "No active SOC episode found for this MRN.");
          completeStep(8, ERROR_SCENARIOS.episode_not_found);
          setSimState("complete");
          return;
        }
        if (errorMode === "already_approved") {
          addLog(8, "SOC episode found but already approved.");
          completeStep(8, ERROR_SCENARIOS.already_approved);
          setSimState("complete");
          return;
        }
        addLog(8, `Active SOC episode located. Status: Open. Patient: ${MOCK_VISITS[activeVisit].patient_first_name} ${MOCK_VISITS[activeVisit].patient_last_name}`);
        completeStep(8);
        await delay(speed * 0.3);

        // Step 9: Map & Populate OASIS
        runStep(9);
        addLog(9, "Navigating OASIS SOC form...");
        await delay(speed * 0.5);
        const oasisKeys = Object.keys(MOCK_OASIS_ANSWERS);
        for (let i = 0; i < oasisKeys.length; i++) {
          await delay(speed * 0.2);
          addLog(9, `Populating ${oasisKeys[i]} = ${MOCK_OASIS_ANSWERS[oasisKeys[i]]}`);
          setOasisFilled(i + 1);
          if ((i + 1) % 5 === 0) {
            addLog(9, "Clicking 'Save and Continue'...");
            await delay(speed * 0.3);
          }
        }
        addLog(9, "All OASIS fields populated. Skipping: Goals & Interventions, 485 Order, Wounds.");
        addLog(9, "\u26D4 STOPPED before Approve/Return/Reject. Human review required.");
        completeStep(9);
        setSimState("complete");
      }
    };

    runSim();

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [simState, speed, errorMode, activeVisit, addLog, runStep, completeStep]);

  const startSimulation = () => {
    setStepStatuses({});
    setStepLogs({});
    setStepErrors({});
    setQueueMessages([]);
    setOasisFilled(0);
    setEventLog([]);
    setSelectedStep(null);
    setSimState("running_a");
  };

  const resetSimulation = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSimState("idle");
    setCurrentStep(0);
    setStepStatuses({});
    setStepLogs({});
    setStepErrors({});
    setQueueMessages([]);
    setOasisFilled(0);
    setEventLog([]);
    setSelectedStep(null);
  };

  const completedSteps = Object.values(stepStatuses).filter(s => s === "success").length;
  const errorSteps = Object.values(stepStatuses).filter(s => s === "error").length;
  const totalSteps = 9;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">Home Health EMR Integration</h1>
              <p className="text-sm text-gray-500">UiPath SOC Automation Prototype \u2014 Phase A & Phase D</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right text-xs text-gray-500">
                <div>{completedSteps}/{totalSteps} steps complete</div>
                {errorSteps > 0 && <div className="text-red-600">{errorSteps} error(s)</div>}
              </div>
              <ProgressBar value={completedSteps} max={totalSteps} color={errorSteps > 0 ? "bg-red-500" : "bg-emerald-500"} />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Control Panel */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex gap-2">
              <button
                onClick={startSimulation}
                disabled={simState !== "idle" && simState !== "complete"}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {simState === "complete" ? "\u25B6 Run Again" : "\u25B6 Start Simulation"}
              </button>
              <button
                onClick={resetSimulation}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                \u21BA Reset
              </button>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Speed:</span>
              <select
                value={speed}
                onChange={e => setSpeed(Number(e.target.value))}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                disabled={simState !== "idle" && simState !== "complete"}
              >
                <option value={2500}>Slow</option>
                <option value={1500}>Normal</option>
                <option value={700}>Fast</option>
                <option value={300}>Instant</option>
              </select>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Error Scenario:</span>
              <select
                value={errorMode}
                onChange={e => setErrorMode(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                disabled={simState !== "idle" && simState !== "complete"}
              >
                <option value="none">None (Happy Path)</option>
                <option value="auth_fail">Auth Retry (Step 1)</option>
                <option value="empty_report">Empty Report (Step 3)</option>
                <option value="validation_fail">Validation Error (Step 4)</option>
                <option value="sqs_fail">Queue Failure (Step 5)</option>
                <option value="episode_not_found">Episode Not Found (Step 8)</option>
                <option value="already_approved">Already Approved (Step 8)</option>
              </select>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Patient:</span>
              <select
                value={activeVisit}
                onChange={e => setActiveVisit(Number(e.target.value))}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                disabled={simState !== "idle" && simState !== "complete"}
              >
                {MOCK_VISITS.map((v, i) => (
                  <option key={i} value={i}>{v.patient_first_name} {v.patient_last_name} ({v.patient_id})</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Status Badges */}
        <div className="flex flex-wrap gap-2 mb-6">
          <Badge color={simState === "idle" ? "gray" : simState === "complete" ? (errorSteps > 0 ? "red" : "green") : "blue"}>
            {simState === "idle" ? "Ready" : simState === "complete" ? (errorSteps > 0 ? "Completed with Errors" : "Completed") : "Running"}
          </Badge>
          {simState === "running_a" && <Badge color="amber">Phase A: Visit Extract</Badge>}
          {simState === "ai_assistant" && <Badge color="purple">AI Assistant Processing</Badge>}
          {simState === "running_d" && <Badge color="amber">Phase D: OASIS Writeback</Badge>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Flow */}
          <div className="lg:col-span-2 space-y-6">
            {/* Phase A */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-bold text-gray-800">Phase A: Visit Extract</h2>
                <Badge color="green">EMR \u2192 UiPath \u2192 Message Queue</Badge>
              </div>
              <div className="space-y-3">
                {PHASE_A_STEPS.map(step => (
                  <StepCard
                    key={step.id}
                    step={step}
                    status={stepStatuses[step.id] || "pending"}
                    isActive={currentStep === step.id}
                    error={stepErrors[step.id]}
                    logs={selectedStep === step.id ? stepLogs[step.id] : null}
                    onClick={() => setSelectedStep(selectedStep === step.id ? null : step.id)}
                  />
                ))}
              </div>
            </div>

            {/* Queue Messages */}
            {queueMessages.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-bold text-gray-700">Queue Messages</h3>
                  <Badge color="amber">{queueMessages.length} messages</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {queueMessages.map((msg, i) => (
                    <QueueMessage key={i} visit={msg} index={i} isAnimating={true} />
                  ))}
                </div>
              </div>
            )}

            {/* AI Assistant Phase */}
            <AiAssistantPhase status={
              simState === "ai_assistant" ? "active" :
              simState === "running_d" || simState === "complete" ? "complete" : "pending"
            } />

            {/* Phase D */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-bold text-gray-800">Phase D: OASIS Writeback</h2>
                <Badge color="green">Orchestrator Queue \u2192 UiPath \u2192 EMR</Badge>
              </div>
              <div className="space-y-3">
                {PHASE_D_STEPS.map(step => (
                  <StepCard
                    key={step.id}
                    step={step}
                    status={stepStatuses[step.id] || "pending"}
                    isActive={currentStep === step.id}
                    error={stepErrors[step.id]}
                    logs={selectedStep === step.id ? stepLogs[step.id] : null}
                    onClick={() => setSelectedStep(selectedStep === step.id ? null : step.id)}
                  />
                ))}
              </div>
            </div>

            {/* OASIS Fields */}
            {oasisFilled > 0 && (
              <OasisFields fields={MOCK_OASIS_ANSWERS} filledCount={oasisFilled} />
            )}

            {/* Data Table */}
            {(simState !== "idle") && (
              <DataTable
                data={MOCK_VISITS}
                title="EMR SOC Schedule Report \u2014 Parsed CSV Data"
                columns={[
                  { key: "patient_id", label: "MRN" },
                  { key: "patient_first_name", label: "First Name" },
                  { key: "patient_last_name", label: "Last Name" },
                  { key: "clinician_id", label: "Clinician" },
                  { key: "visit_id", label: "Visit ID" },
                  { key: "visit_type", label: "Type" },
                  { key: "visit_date", label: "Date" },
                  { key: "visit_start_time", label: "Time" },
                ]}
              />
            )}
          </div>

          {/* Sidebar: Event Log & Config */}
          <div className="space-y-4">
            {/* Config Summary */}
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3">Configuration</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-gray-500">Credential Store</span><span className="font-mono">Orchestrator Assets</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Auth Retries</span><span className="font-mono">3x / 10s delay</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Export Timeout</span><span className="font-mono">60 seconds</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Message Queue</span><span className="font-mono">soc-visits-queue</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Staging Folder</span><span className="font-mono">\\shared\uipath\staging\</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Date Range</span><span className="font-mono">Today (configurable)</span></div>
              </div>
            </div>

            {/* Open Blockers */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <h3 className="text-sm font-bold text-amber-800 mb-2">Open Blockers</h3>
              <div className="space-y-2 text-xs text-amber-700">
                <div className="p-2 bg-amber-100 rounded">
                  <p className="font-semibold">Visit ID</p>
                  <p>EMR may not expose unique visit-level ID. Using MRN + Date + Time as composite key.</p>
                </div>
                <div className="p-2 bg-amber-100 rounded">
                  <p className="font-semibold">Clinician ID</p>
                  <p>No unique employee ID for pilot agency. Using clinician name as fallback until resolved.</p>
                </div>
                <div className="p-2 bg-amber-100 rounded">
                  <p className="font-semibold">OASIS Field Mapping</p>
                  <p>EMR page sequence must be confirmed with EMR Admin before Phase D can be built.</p>
                </div>
              </div>
            </div>

            {/* Phase D Pre-conditions */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <h3 className="text-sm font-bold text-blue-800 mb-2">Phase D Pre-Conditions</h3>
              <div className="space-y-1 text-xs text-blue-700">
                <div className="flex items-start gap-2">
                  <span>{"\u25CB"}</span>
                  <span>OASIS question order mapping finalized (EMR sequence confirmed by Admin)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span>{"\u25CB"}</span>
                  <span>AI Assistant API exposes OASIS answers in machine-readable format</span>
                </div>
                <div className="flex items-start gap-2">
                  <span>{"\u25CB"}</span>
                  <span>Phase A bot is live and creating visits successfully</span>
                </div>
              </div>
            </div>

            {/* Event Log */}
            <div className="bg-gray-900 rounded-xl p-4 max-h-96 overflow-y-auto">
              <h3 className="text-sm font-bold text-gray-300 mb-3">Event Log</h3>
              {eventLog.length === 0 ? (
                <p className="text-xs text-gray-500 italic">Start the simulation to see events...</p>
              ) : (
                <div className="space-y-1 font-mono text-xs">
                  {eventLog.map((log, i) => (
                    <div key={i} className={`${
                      log.includes("FAILED") || log.includes("ERROR") ? "text-red-400" :
                      log.includes("\u2713") || log.includes("complete") || log.includes("Success") || log.includes("success") ? "text-emerald-400" :
                      "text-green-300"
                    }`}>
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Out of Scope */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-2">Out of Scope</h3>
              <div className="space-y-1 text-xs text-gray-500">
                <div>{"\u2022"} AI Assistant mobile app</div>
                <div>{"\u2022"} AI transcription engine</div>
                <div>{"\u2022"} Clinician recording</div>
                <div>{"\u2022"} Goals & Interventions (always manual QN)</div>
                <div>{"\u2022"} 485 order generation</div>
                <div>{"\u2022"} Wounds / Patient Photos</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
