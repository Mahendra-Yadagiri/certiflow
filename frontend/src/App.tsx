import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

type UserRole = "CENTRE" | "DISTRICT_OFFICER" | "QUALITY_TEAM" | "STATE_OFFICE";
type BatchStatus =
  | "SUBMITTED"
  | "DISTRICT_APPROVED"
  | "QUALITY_APPROVED"
  | "STATE_APPROVED"
  | "ISSUED"
  | "REJECTED"
  | "CHANGES_REQUESTED";

type User = {
  id: string;
  name: string;
  role: UserRole;
  district: string | null;
};

type Candidate = {
  id: string;
  fullName: string;
  phone: string;
  rollNumber: string;
};

type Certificate = {
  id: string;
  candidateId: string;
  certificateNumber: string;
  status: "VALID" | "REVOKED";
  whatsappStatus: "PENDING" | "SENT" | "FAILED";
  issuedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
};

type AuditLog = {
  id: string;
  entityType: string;
  action: string;
  actorId: string;
  metadata: unknown;
  createdAt: string;
};

type Batch = {
  id: string;
  centreId: string;
  district: string;
  courseName: string;
  status: BatchStatus;
  candidateCount: number;
  isSlaBreached: boolean;
  createdAt: string;
  updatedAt: string;
  candidates?: Candidate[];
  certificates?: Certificate[];
  approvals?: Array<{
    id: string;
    officerId: string;
    stage: string;
    decision: string;
    reason: string | null;
    createdAt: string;
  }>;
  auditLogs?: AuditLog[];
};

type ApiError = {
  row?: number;
  field?: string;
  message: string;
};

type VerificationResult = {
  valid: boolean;
  certificate: (Certificate & {
    candidate: Candidate;
    batch: Batch;
  }) | null;
};

const personaLabels: Record<UserRole, string> = {
  CENTRE: "Training Centre",
  DISTRICT_OFFICER: "District Officer",
  QUALITY_TEAM: "Quality Team",
  STATE_OFFICE: "State Office",
};

async function request<T>(
  path: string,
  user: User | null,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (user) headers.set("x-user-id", user.id);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error ?? `Request failed with status ${response.status}`,
    ) as Error & { status: number; errors?: ApiError[] };
    error.status = response.status;
    error.errors = payload?.errors;
    throw error;
  }
  return payload as T;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function canReview(batch: Batch, user: User | null) {
  if (!user) return false;
  if (
    user.role === "DISTRICT_OFFICER" &&
    batch.status === "SUBMITTED" &&
    user.district === batch.district
  ) {
    return true;
  }
  if (
    user.role === "QUALITY_TEAM" &&
    batch.status === "DISTRICT_APPROVED" &&
    batch.candidateCount > 30
  ) {
    return true;
  }
  return (
    user.role === "STATE_OFFICE" &&
    (batch.status === "QUALITY_APPROVED" ||
      (batch.status === "DISTRICT_APPROVED" && batch.candidateCount <= 30))
  );
}

function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [verificationMode, setVerificationMode] = useState(
    window.location.pathname === "/verify",
  );
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);

  const refreshBatches = useCallback(
    (activeUser: User) => request<Batch[]>("/api/batches", activeUser),
    [],
  );
  const applyBatchList = useCallback((nextBatches: Batch[]) => {
    setBatches(nextBatches);
    setSelectedBatch((current) => {
      if (!current) return current;
      const refreshed = nextBatches.find((batch) => batch.id === current.id);
      return refreshed ? { ...current, ...refreshed } : current;
    });
  }, []);

  const refreshDetail = useCallback(
    (batchId: string, activeUser: User) =>
      request<Batch>(`/api/batches/${batchId}`, activeUser),
    [],
  );

  useEffect(() => {
    let active = true;
    request<User[]>("/api/users", null)
      .then((loadedUsers) => {
        if (!active) return;
        setUsers(loadedUsers);
        const preferred = loadedUsers.find((candidate) => candidate.id === "anika");
        setUser(preferred ?? loadedUsers[0] ?? null);
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setError("");
    refreshBatches(user)
      .then((nextBatches) => {
        if (active) applyBatchList(nextBatches);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [applyBatchList, refreshBatches, user]);

  const userRef = useRef(user);
  const selectedBatchRef = useRef(selectedBatch);
  useEffect(() => {
    userRef.current = user;
    selectedBatchRef.current = selectedBatch;
  }, [selectedBatch, user]);

  useEffect(() => {
    const events = new EventSource(`${API_BASE}/api/events`);
    events.onopen = () => setLive(true);
    events.onerror = () => setLive(false);
    events.onmessage = () => {
      const activeUser = userRef.current;
      if (!activeUser) return;
      void refreshBatches(activeUser)
        .then(applyBatchList)
        .catch((cause: unknown) => setError(errorText(cause)));
      const activeBatch = selectedBatchRef.current;
      if (activeBatch) {
        void refreshDetail(activeBatch.id, activeUser)
          .then(setSelectedBatch)
          .catch((cause: unknown) => setError(errorText(cause)));
      }
    };
    return () => events.close();
  }, [applyBatchList, refreshBatches, refreshDetail]);

  useEffect(() => {
    const syncPath = () => setVerificationMode(window.location.pathname === "/verify");
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const navigate = (toVerify: boolean) => {
    const path = toVerify ? "/verify" : "/";
    window.history.pushState({}, "", path);
    setVerificationMode(toVerify);
    setSelectedBatch(null);
    setNotice("");
    setError("");
  };

  const handleUserChange = (id: string) => {
    setUser(users.find((candidate) => candidate.id === id) ?? null);
    setSelectedBatch(null);
    setNotice("");
  };

  const updateBatch = (batch: Batch) => {
    setBatches((current) => [
      { ...(current.find((item) => item.id === batch.id) ?? {}), ...batch },
      ...current.filter((item) => item.id !== batch.id),
    ]);
    setSelectedBatch((current) =>
      current?.id === batch.id ? { ...current, ...batch } : batch,
    );
  };

  const detailTitle = useMemo(
    () => selectedBatch?.courseName ?? "",
    [selectedBatch],
  );

  if (loading) {
    return <main className="loading-screen">Loading Certiflow…</main>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate(false)} aria-label="Certiflow home">
          <span className="brand-mark">C</span>
          <span>
            <strong>certiflow</strong>
            <small>Certificate operations</small>
          </span>
        </button>
        <div className="topbar-actions">
          <div className={`live-indicator ${live ? "is-live" : ""}`}>
            <span />
            {live ? "Live updates on" : "Connecting"}
          </div>
          {!verificationMode && user && (
            <label className="persona-control">
              <span className="sr-only">Switch persona</span>
              <select
                value={user.id}
                onChange={(event) => handleUserChange(event.target.value)}
              >
                {users.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.name} — {personaLabels[candidate.role]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <nav className="view-tabs" aria-label="Main views">
        <button
          className={!verificationMode ? "tab active" : "tab"}
          onClick={() => navigate(false)}
        >
          Workspace
        </button>
        <button
          className={verificationMode ? "tab active" : "tab"}
          onClick={() => navigate(true)}
        >
          Public Certificate Verification
        </button>
      </nav>

      <main className="page-content">
        {error && (
          <div className="notice notice-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
          </div>
        )}
        {notice && (
          <div className="notice notice-success" role="status">
            {notice}
            <button onClick={() => setNotice("")} aria-label="Dismiss message">×</button>
          </div>
        )}

        {verificationMode ? (
          <PublicVerification />
        ) : selectedBatch ? (
          <BatchDetail
            batch={selectedBatch}
            user={user}
            onBack={() => setSelectedBatch(null)}
            onBatchUpdate={updateBatch}
            onError={(message) => setError(message)}
            onNotice={(message) => setNotice(message)}
          />
        ) : (
          <Dashboard
            user={user}
            batches={batches}
            onSelect={(batch) => {
              if (!user) return;
              setError("");
              void refreshDetail(batch.id, user)
                .then(setSelectedBatch)
                .catch((cause: unknown) => setError(errorText(cause)));
            }}
            onBatchesChange={setBatches}
            onError={(message) => setError(message)}
            onNotice={(message) => setNotice(message)}
          />
        )}
        {!verificationMode && selectedBatch && (
          <span className="sr-only" aria-live="polite">
            Open batch {detailTitle}
          </span>
        )}
      </main>
      <footer className="footer">
        <span>Certiflow</span>
        <span>Secure credential operations</span>
      </footer>
    </div>
  );
}

function Dashboard({
  user,
  batches,
  onSelect,
  onBatchesChange,
  onError,
  onNotice,
}: {
  user: User | null;
  batches: Batch[];
  onSelect: (batch: Batch) => void;
  onBatchesChange: (batches: Batch[]) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [courseName, setCourseName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<ApiError[]>([]);
  const [resubmitBatch, setResubmitBatch] = useState<string | null>(null);
  const [resubmitFile, setResubmitFile] = useState<File | null>(null);
  const [resubmitErrors, setResubmitErrors] = useState<ApiError[]>([]);
  const [resubmitting, setResubmitting] = useState(false);

  const uploadBatch = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !file) {
      setUploadErrors([{ field: "file", message: "Choose a CSV file to upload." }]);
      return;
    }

    setUploading(true);
    setUploadErrors([]);
    onError("");
    const body = new FormData();
    body.append("courseName", courseName);
    body.append("file", file);
    try {
      const batch = await request<Batch>("/api/batches/upload", user, {
        method: "POST",
        body,
      });
      onBatchesChange([batch, ...batches.filter((current) => current.id !== batch.id)]);
      setCourseName("");
      setFile(null);
      const input = document.getElementById("batch-csv") as HTMLInputElement | null;
      if (input) input.value = "";
      onNotice("Batch uploaded and submitted for review.");
    } catch (cause) {
      const apiError = cause as Error & { errors?: ApiError[] };
      if (apiError.errors?.length) setUploadErrors(apiError.errors);
      else onError(errorText(cause));
    } finally {
      setUploading(false);
    }
  };

  const resubmit = async (event: FormEvent, batchId: string) => {
    event.preventDefault();
    if (!user || !resubmitFile) {
      setResubmitErrors([{ field: "file", message: "Choose a CSV file to resubmit." }]);
      return;
    }

    setResubmitting(true);
    setResubmitErrors([]);
    const body = new FormData();
    body.append("file", resubmitFile);
    try {
      const updated = await request<Batch>(`/api/batches/${batchId}/resubmit`, user, {
        method: "PUT",
        body,
      });
      onBatchesChange([
        updated,
        ...batches.filter((batch) => batch.id !== updated.id),
      ]);
      setResubmitBatch(null);
      setResubmitFile(null);
      onNotice("Batch resubmitted successfully.");
    } catch (cause) {
      const apiError = cause as Error & { errors?: ApiError[] };
      if (apiError.errors?.length) setResubmitErrors(apiError.errors);
      else onError(errorText(cause));
    } finally {
      setResubmitting(false);
    }
  };

  return (
    <>
      <section className="welcome-row">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>{user ? `Welcome, ${user.name}` : "Certificate dashboard"}</h1>
          <p className="subheading">
            {user ? `${personaLabels[user.role]}${user.district ? ` · ${user.district} district` : ""}` : "Select a persona to continue."}
          </p>
        </div>
        <div className="summary-card">
          <span className="summary-icon">▤</span>
          <span>
            <strong>{batches.length}</strong>
            <small>Visible batches</small>
          </span>
        </div>
      </section>

      {user?.role === "CENTRE" && (
        <section className="panel upload-panel">
          <div className="panel-heading">
            <div className="section-icon">↑</div>
            <div>
              <h2>Upload Batch CSV</h2>
              <p>Submit candidate records for review. CSV columns: fullName, phone, rollNumber.</p>
            </div>
          </div>
          <form onSubmit={uploadBatch} className="upload-form">
            <label className="field">
              <span>Course name</span>
              <input
                value={courseName}
                onChange={(event) => setCourseName(event.target.value)}
                placeholder="e.g. Solar Panel Installation"
                required
              />
            </label>
            <label className="field file-field">
              <span>Candidate CSV</span>
              <input
                id="batch-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                required
              />
            </label>
            <button className="button button-primary upload-submit" disabled={uploading}>
              {uploading ? "Uploading…" : "Upload & Submit"}
            </button>
          </form>
          <ErrorList errors={uploadErrors} />
        </section>
      )}

      <section className="batch-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">WORK QUEUE</p>
            <h2>Your batches</h2>
          </div>
          <span className="count-pill">{batches.length} total</span>
        </div>
        {batches.length === 0 ? (
          <div className="empty-state panel">
            <div className="empty-icon">▤</div>
            <h3>No batches to show</h3>
            <p>New batches and review requests will appear here.</p>
          </div>
        ) : (
          <div className="batch-list">
            {batches.map((batch) => (
              <article
                className="batch-card"
                key={batch.id}
                onClick={() => onSelect(batch)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelect(batch);
                }}
                role="button"
                tabIndex={0}
              >
                <div className="batch-card-main">
                  <div className="batch-card-title">
                    <h3>{batch.courseName}</h3>
                    <StatusBadge status={batch.status} />
                  </div>
                  <p className="batch-meta">
                    <span>{batch.candidateCount} candidates</span>
                    <span className="meta-dot">·</span>
                    <span>{batch.district}</span>
                    <span className="meta-dot">·</span>
                    <span>Created {formatDate(batch.createdAt)}</span>
                  </p>
                  <div className="batch-tags">
                    {batch.candidateCount > 30 && (
                      <span className="tag tag-quality">Large Batch · Quality Review</span>
                    )}
                    {batch.isSlaBreached && (
                      <span className="tag tag-sla">⚠ SLA BREACHED</span>
                    )}
                  </div>
                </div>
                <span className="card-arrow">→</span>
                {user?.role === "CENTRE" && batch.status === "CHANGES_REQUESTED" && (
                  <div
                    className="resubmit-area"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {resubmitBatch === batch.id ? (
                      <form
                        className="resubmit-form"
                        onSubmit={(event) => void resubmit(event, batch.id)}
                      >
                        <label className="field compact-field">
                          <span>Updated candidate CSV</span>
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            onChange={(event) => setResubmitFile(event.target.files?.[0] ?? null)}
                            required
                          />
                        </label>
                        <div className="inline-buttons">
                          <button className="button button-primary button-small" disabled={resubmitting}>
                            {resubmitting ? "Sending…" : "Submit fix"}
                          </button>
                          <button
                            className="button button-quiet button-small"
                            type="button"
                            onClick={() => {
                              setResubmitBatch(null);
                              setResubmitErrors([]);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                        <ErrorList errors={resubmitErrors} />
                      </form>
                    ) : (
                      <button
                        className="button button-secondary button-small"
                        onClick={(event) => {
                          event.stopPropagation();
                          setResubmitBatch(batch.id);
                          setResubmitFile(null);
                          setResubmitErrors([]);
                        }}
                      >
                        Fix & Resubmit
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function BatchDetail({
  batch,
  user,
  onBack,
  onBatchUpdate,
  onError,
  onNotice,
}: {
  batch: Batch;
  user: User | null;
  onBack: () => void;
  onBatchUpdate: (batch: Batch) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [decisionReason, setDecisionReason] = useState("");
  const [decision, setDecision] = useState<"SENT_BACK" | "REJECTED" | null>(null);
  const [savingDecision, setSavingDecision] = useState(false);
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [revoking, setRevoking] = useState<string | null>(null);
  const certificateByCandidate = new Map(
    (batch.certificates ?? []).map((certificate) => [certificate.candidateId, certificate]),
  );

  const submitDecision = async (action: "APPROVED" | "SENT_BACK" | "REJECTED") => {
    if (!user) return;
    if (action !== "APPROVED" && !decisionReason.trim()) {
      onError("Add a reason before sending back or rejecting this batch.");
      return;
    }
    setSavingDecision(true);
    onError("");
    try {
      const updated = await request<Batch>(`/api/batches/${batch.id}/decision`, user, {
        method: "POST",
        body: JSON.stringify({
          decision: action,
          ...(action !== "APPROVED" ? { reason: decisionReason.trim() } : {}),
        }),
      });
      onBatchUpdate(updated);
      setDecision(null);
      setDecisionReason("");
      onNotice(action === "APPROVED" ? "Approval recorded." : "Batch decision recorded.");
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setSavingDecision(false);
    }
  };

  const revokeCertificate = async (certificate: Certificate) => {
    if (!user) return;
    const reason = revokeReasons[certificate.id]?.trim();
    if (!reason) {
      onError("Add a reason before revoking a certificate.");
      return;
    }
    setRevoking(certificate.id);
    onError("");
    try {
      await request<Certificate>(`/api/certificates/${certificate.id}/revoke`, user, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      const updated = await request<Batch>(`/api/batches/${batch.id}`, user);
      onBatchUpdate(updated);
      onNotice("Certificate revoked.");
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setRevoking(null);
    }
  };

  const candidates = batch.candidates ?? [];
  const auditLogs = [...(batch.auditLogs ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return (
    <>
      <button className="back-link" onClick={onBack}>← Back to batches</button>
      <section className="detail-header panel">
        <div>
          <p className="eyebrow">BATCH DETAIL</p>
          <h1>{batch.courseName}</h1>
          <p className="subheading">{batch.district} district <span>·</span> {batch.candidateCount} candidates</p>
        </div>
        <div className="detail-status">
          <StatusBadge status={batch.status} />
          {batch.isSlaBreached && <span className="tag tag-sla">⚠ SLA BREACHED</span>}
        </div>
      </section>

      {canReview(batch, user) && (
        <section className="panel action-panel">
          <div className="panel-heading">
            <div className="section-icon">✓</div>
            <div>
              <h2>Review this batch</h2>
              <p>Choose an action for the current review stage.</p>
            </div>
          </div>
          <div className="decision-controls">
            <button
              className="button button-primary"
              onClick={() => void submitDecision("APPROVED")}
              disabled={savingDecision}
            >
              Approve
            </button>
            <button
              className="button button-secondary"
              onClick={() => {
                setDecision(decision === "SENT_BACK" ? null : "SENT_BACK");
                setDecisionReason("");
              }}
            >
              Send Back
            </button>
            <button
              className="button button-danger-outline"
              onClick={() => {
                setDecision(decision === "REJECTED" ? null : "REJECTED");
                setDecisionReason("");
              }}
            >
              Reject
            </button>
          </div>
          {decision && (
            <div className="decision-reason">
              <label className="field">
                <span>{decision === "SENT_BACK" ? "Reason for requested changes" : "Reason for rejection"}</span>
                <textarea
                  value={decisionReason}
                  onChange={(event) => setDecisionReason(event.target.value)}
                  placeholder="Provide a clear reason for the centre"
                  rows={3}
                />
              </label>
              <button
                className={decision === "REJECTED" ? "button button-danger" : "button button-primary"}
                disabled={savingDecision || !decisionReason.trim()}
                onClick={() => void submitDecision(decision)}
              >
                {savingDecision ? "Submitting…" : decision === "SENT_BACK" ? "Send back batch" : "Confirm rejection"}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="panel candidate-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ROSTER</p>
            <h2>Candidates <span className="heading-count">{candidates.length}</span></h2>
          </div>
        </div>
        {candidates.length === 0 ? (
          <p className="muted empty-copy">No candidate records found.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Roll number</th>
                  <th>Certificate</th>
                  <th>WhatsApp</th>
                  {user?.role === "STATE_OFFICE" && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => {
                  const certificate = certificateByCandidate.get(candidate.id);
                  return (
                    <tr key={candidate.id}>
                      <td>
                        <strong>{candidate.fullName}</strong>
                        <small className="table-subtext">{candidate.phone}</small>
                      </td>
                      <td>{candidate.rollNumber}</td>
                      <td>
                        {certificate ? (
                          <div className="certificate-cell">
                            <span className="certificate-number">{certificate.certificateNumber}</span>
                            <StatusBadge status={certificate.status} />
                          </div>
                        ) : <span className="muted">Not issued</span>}
                      </td>
                      <td>
                        {certificate ? (
                          <span className={`delivery-status delivery-${certificate.whatsappStatus.toLowerCase()}`}>
                            <span />
                            {certificate.whatsappStatus}
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      {user?.role === "STATE_OFFICE" && (
                        <td>
                          {certificate?.status === "VALID" ? (
                            <div className="revoke-controls">
                              <input
                                aria-label={`Revocation reason for ${candidate.fullName}`}
                                placeholder="Reason"
                                value={revokeReasons[certificate.id] ?? ""}
                                onChange={(event) =>
                                  setRevokeReasons((current) => ({
                                    ...current,
                                    [certificate.id]: event.target.value,
                                  }))
                                }
                              />
                              <button
                                className="button button-danger-outline button-small"
                                disabled={revoking === certificate.id}
                                onClick={() => void revokeCertificate(certificate)}
                              >
                                {revoking === certificate.id ? "Revoking…" : "Revoke"}
                              </button>
                            </div>
                          ) : certificate?.status === "REVOKED" ? (
                            <span className="muted">Revoked</span>
                          ) : <span className="muted">—</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel audit-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACTIVITY</p>
            <h2>Audit timeline</h2>
          </div>
        </div>
        {auditLogs.length === 0 ? (
          <p className="muted empty-copy">No activity recorded yet.</p>
        ) : (
          <ol className="timeline">
            {auditLogs.map((log) => (
              <li key={log.id}>
                <span className="timeline-marker" />
                <div className="timeline-content">
                  <strong>{log.action.replaceAll("_", " ")}</strong>
                  <p>
                    {log.actorId === user?.id ? "You" : `User ${log.actorId}`}
                    <span> · </span>
                    {formatDate(log.createdAt)}
                  </p>
                  {log.metadata && typeof log.metadata === "object" && (
                    <small>{Object.entries(log.metadata).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</small>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function PublicVerification() {
  const [certificateNumber, setCertificateNumber] = useState("");
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    const number = certificateNumber.trim();
    if (!number) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await request<VerificationResult>(
        `/api/verify/${encodeURIComponent(number)}`,
        null,
      );
      setResult(response);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  };

  const certificate = result?.certificate;

  return (
    <section className="verify-page">
      <div className="verify-intro">
        <div className="verify-icon">✓</div>
        <p className="eyebrow">PUBLIC LOOKUP</p>
        <h1>Verify a certificate</h1>
        <p>Check whether a Certiflow-issued credential is genuine and currently valid.</p>
      </div>
      <form className="verify-form panel" onSubmit={(event) => void verify(event)}>
        <label className="field">
          <span>Certificate number</span>
          <input
            value={certificateNumber}
            onChange={(event) => setCertificateNumber(event.target.value)}
            placeholder="e.g. PSM-2026-ABC123"
            autoComplete="off"
            required
          />
        </label>
        <button className="button button-primary" disabled={loading}>
          {loading ? "Checking…" : "Verify certificate"}
        </button>
      </form>
      {error && <div className="verification-result invalid-result" role="alert">{error}</div>}
      {result && result.valid && certificate ? (
        <div className="verification-result valid-result" role="status">
          <div className="result-symbol">✓</div>
          <div>
            <p className="eyebrow">CERTIFICATE STATUS</p>
            <h2>GENUINE &amp; VALID</h2>
            <div className="verified-details">
              <span><small>Certificate holder</small><strong>{certificate.candidate.fullName}</strong></span>
              <span><small>Course</small><strong>{certificate.batch.courseName}</strong></span>
              <span><small>Issue date</small><strong>{formatDate(certificate.issuedAt)}</strong></span>
              <span><small>Certificate number</small><strong>{certificate.certificateNumber}</strong></span>
            </div>
          </div>
        </div>
      ) : result ? (
        <div className="verification-result invalid-result" role="alert">
          <div className="result-symbol">!</div>
          <div>
            <p className="eyebrow">CERTIFICATE STATUS</p>
            <h2>{certificate?.status === "REVOKED" ? "REVOKED" : "INVALID"}</h2>
            <p>
              {certificate?.status === "REVOKED"
                ? certificate.revokeReason || "This certificate has been revoked."
                : "No certificate was found for this number."}
            </p>
            {certificate?.revokedAt && (
              <p className="revocation-date">Revoked {formatDate(certificate.revokedAt)}</p>
            )}
          </div>
        </div>
      ) : (
        <p className="verify-footnote">Verification is public. No account is required.</p>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    SUBMITTED: "status-submitted",
    DISTRICT_APPROVED: "status-district",
    QUALITY_APPROVED: "status-quality",
    STATE_APPROVED: "status-state",
    ISSUED: "status-issued",
    REJECTED: "status-rejected",
    CHANGES_REQUESTED: "status-changes",
    VALID: "status-issued",
    REVOKED: "status-rejected",
  };
  return (
    <span className={`status-badge ${styles[status] ?? ""}`}>
      <span />
      {status.replaceAll("_", " ")}
    </span>
  );
}

function ErrorList({ errors }: { errors: ApiError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="row-errors" role="alert">
      <strong>Please correct the following:</strong>
      <ul>
        {errors.map((item, index) => (
          <li key={`${item.row ?? "x"}-${item.field ?? "x"}-${index}`}>
            {item.row ? `Row ${item.row}` : "File"}
            {item.field ? ` · ${item.field}` : ""}: {item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;
