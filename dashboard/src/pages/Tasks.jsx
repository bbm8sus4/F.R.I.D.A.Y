import React, { useState, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { apiFetch } from "../api/client";
import FilterBar from "../components/FilterBar";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "done", label: "Done" },
];

export default function Tasks() {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [resolving, setResolving] = useState(false);

  const { data, loading, error, refetch } = useApi(
    `/api/tasks?status=${status}&page=${page}&limit=20`
  );

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [resolveError, setResolveError] = useState(null);

  const markDone = useCallback(async (id) => {
    setResolving(true);
    setResolveError(null);
    try {
      await apiFetch(`/api/tasks/${id}/done`, { method: "PATCH" });
      refetch();
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch (e) { setResolveError(e.message); } finally { setResolving(false); }
  }, [refetch]);

  const markSelectedDone = useCallback(async () => {
    if (selected.size === 0) return;
    setResolving(true);
    setResolveError(null);
    try {
      const ids = [...selected];
      const results = await Promise.allSettled(ids.map((id) =>
        apiFetch(`/api/tasks/${id}/done`, { method: "PATCH" })
      ));
      const failedIds = ids.filter((_, i) => results[i].status === "rejected");
      if (failedIds.length > 0) {
        const firstErr = results.find(r => r.status === "rejected")?.reason?.message || "Unknown error";
        setResolveError(`Failed ${failedIds.length}/${ids.length}: ${firstErr}`);
        // Keep failed ids selected so the user can retry
        setSelected(new Set(failedIds));
      } else {
        setSelected(new Set());
      }
      refetch();
    } catch (e) { setResolveError(e.message); } finally { setResolving(false); }
  }, [selected, refetch]);

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  return (
    <>
      <div className="page-title">Tasks</div>
      <FilterBar options={STATUS_OPTIONS} value={status} onChange={(v) => { setStatus(v); setPage(1); setSelected(new Set()); }} />

      {selected.size > 0 && status === "pending" && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          <button onClick={markSelectedDone} disabled={resolving}>Mark Done</button>
        </div>
      )}

      {loading && <div className="loading"><div className="spinner" /><p>Loading...</p></div>}
      {(error || resolveError) && <div className="error-state">Error: {error || resolveError}</div>}

      {!loading && data?.data?.length === 0 && (
        <EmptyState message={status === "pending" ? "No pending tasks" : "No completed tasks"} />
      )}

      {!loading && data?.data?.map((t) => (
        <div key={t.id} className="list-item">
          {status === "pending" && (
            <div
              className={`checkbox ${selected.has(t.id) ? "checked" : ""}`}
              onClick={() => toggleSelect(t.id)}
            >
              {selected.has(t.id) && "✓"}
            </div>
          )}
          <div className="content">
            <div className="title">{t.description}</div>
            <div className="meta">
              #{t.id}{t.due_on ? ` — Due: ${t.due_on}` : ""} — {t.created_at}
            </div>
          </div>
          <div className="actions">
            {status === "pending" ? (
              <button className="btn btn-primary" onClick={() => markDone(t.id)} disabled={resolving}>
                Done
              </button>
            ) : (
              <Badge type="resolved">Done</Badge>
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
