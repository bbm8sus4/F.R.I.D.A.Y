import React, { useState, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { apiFetch } from "../api/client";
import FilterBar from "../components/FilterBar";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
];

export default function Commitments() {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [resolving, setResolving] = useState(false);

  const { data, loading, error, refetch } = useApi(
    `/api/commitments?status=${status}&page=${page}&limit=20`
  );

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [resolveError, setResolveError] = useState(null);

  const resolveOne = useCallback(async (id) => {
    setResolving(true);
    setResolveError(null);
    try {
      await apiFetch(`/api/commitments/${id}/resolve`, { method: "PATCH" });
      refetch();
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch (e) { setResolveError(e.message); } finally { setResolving(false); }
  }, [refetch]);

  const resolveBulk = useCallback(async () => {
    if (selected.size === 0) return;
    setResolving(true);
    setResolveError(null);
    try {
      await apiFetch("/api/commitments/resolve-bulk", {
        method: "PATCH",
        body: JSON.stringify({ ids: [...selected] }),
      });
      setSelected(new Set());
      refetch();
    } catch (e) { setResolveError(e.message); } finally { setResolving(false); }
  }, [selected, refetch]);

  const resolveAll = useCallback(async () => {
    setResolving(true);
    setResolveError(null);
    try {
      await apiFetch("/api/commitments/resolve-bulk", {
        method: "PATCH",
        body: JSON.stringify({ all: true }),
      });
      setSelected(new Set());
      refetch();
    } catch (e) { setResolveError(e.message); } finally { setResolving(false); }
  }, [refetch]);

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  return (
    <>
      <div className="page-title">Commitments</div>
      <FilterBar options={STATUS_OPTIONS} value={status} onChange={(v) => { setStatus(v); setPage(1); setSelected(new Set()); }} />

      {selected.size > 0 && status === "pending" && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={resolveBulk} disabled={resolving}>Resolve Selected</button>
            <button onClick={resolveAll} disabled={resolving}>Resolve All</button>
          </div>
        </div>
      )}

      {loading && <div className="loading"><div className="spinner" /><p>Loading...</p></div>}
      {(error || resolveError) && <div className="error-state">Error: {error || resolveError}</div>}

      {!loading && data?.data?.length === 0 && (
        <EmptyState message={status === "pending" ? "No pending commitments" : "No resolved commitments"} />
      )}

      {!loading && data?.data?.map((c) => (
        <div key={c.id} className="list-item">
          {status === "pending" && (
            <div
              className={`checkbox ${selected.has(c.id) ? "checked" : ""}`}
              onClick={() => toggleSelect(c.id)}
            >
              {selected.has(c.id) && "✓"}
            </div>
          )}
          <div className="content">
            <div className="title">{c.promise_text}</div>
            <div className="meta">
              #{c.id} — {c.username ? `@${c.username}` : c.first_name || "Unknown"} — {c.created_at}
            </div>
          </div>
          <div className="actions">
            {status === "pending" ? (
              <button className="btn btn-primary" onClick={() => resolveOne(c.id)} disabled={resolving}>
                Resolve
              </button>
            ) : (
              <Badge type="resolved">Resolved</Badge>
            )}
          </div>
        </div>
      ))}

      {data && totalPages > 1 && (
        <div className="pagination">
          <button className="btn btn-outline" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Prev
          </button>
          <span>{page} / {totalPages}</span>
          <button className="btn btn-outline" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
