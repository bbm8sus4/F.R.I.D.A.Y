import React, { useState } from "react";
import { useApi } from "../hooks/useApi";
import FilterBar from "../components/FilterBar";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";

const URGENCY_OPTIONS = [
  { value: "", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function BarChart({ data, labelKey, valueKey }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d[valueKey]));
  return (
    <div className="bar-chart">
      {data.map((d, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label">{d[labelKey]}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(d[valueKey] / max) * 100}%` }} />
          </div>
          <span className="bar-value">{d[valueKey]}</span>
        </div>
      ))}
    </div>
  );
}

export default function Alerts() {
  const [urgency, setUrgency] = useState("");
  const [page, setPage] = useState(1);
  const [showPatterns, setShowPatterns] = useState(false);

  const params = new URLSearchParams({ page, limit: 20 });
  if (urgency) params.set("urgency", urgency);

  const { data, loading, error } = useApi(`/api/alerts?${params}`);
  const { data: patterns, loading: pLoading } = useApi("/api/alerts/patterns");

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  return (
    <>
      <div className="page-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Alerts</span>
        <button className="btn btn-outline" onClick={() => setShowPatterns((p) => !p)} style={{ fontSize: 12 }}>
          {showPatterns ? "List" : "Patterns"}
        </button>
      </div>

      {showPatterns ? (
        <>
          {pLoading && <div className="loading"><div className="spinner" /><p>Loading...</p></div>}
          {patterns && (
            <>
              <div className="section-header">By Urgency</div>
              <div className="card">
                <BarChart data={patterns.byUrgency} labelKey="urgency" valueKey="count" />
              </div>
              <div className="section-header">By Group (30d)</div>
              <div className="card">
                <BarChart data={patterns.byGroup} labelKey="chat_title" valueKey="count" />
              </div>
              <div className="section-header">By Category (30d)</div>
              <div className="card">
                <BarChart data={patterns.byCategory} labelKey="category" valueKey="count" />
              </div>
              <div className="section-header">Daily (14d)</div>
              <div className="card">
                <BarChart data={patterns.byDay} labelKey="day" valueKey="count" />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <FilterBar options={URGENCY_OPTIONS} value={urgency} onChange={(v) => { setUrgency(v); setPage(1); }} />

          {loading && <div className="loading"><div className="spinner" /><p>Loading...</p></div>}
          {error && <div className="error-state">Error: {error}</div>}

          {!loading && data?.data?.length === 0 && <EmptyState message="No alerts found" />}

          {!loading && data?.data?.map((a) => (
            <div key={a.id} className="list-item" style={{ flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Badge type={a.urgency}>{a.urgency}</Badge>
                {a.category && <Badge type="new">{a.category}</Badge>}
                {a.chat_title && <span style={{ fontSize: 12, color: "var(--hint)" }}>{a.chat_title}</span>}
              </div>
              <div className="title">{a.summary}</div>
              <div className="meta">
                {a.who && `${a.who} — `}{a.created_at}
                {a.boss_action && ` — ${a.boss_action}`}
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
      )}
    </>
  );
}
