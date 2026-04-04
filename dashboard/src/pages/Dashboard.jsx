import React from "react";
import { useApi } from "../hooks/useApi";
import StatCard from "../components/StatCard";
import EmptyState from "../components/EmptyState";

export default function Dashboard({ onNavigate }) {
  const { data, loading, error } = useApi("/api/dashboard");

  if (loading) return <div className="loading"><div className="spinner" /><p>Loading...</p></div>;
  if (error) return <div className="error-state">Error: {error}</div>;
  if (!data) return <EmptyState message="No data available" />;

  const alertTotal = Object.values(data.alerts).reduce((s, n) => s + n, 0);

  return (
    <>
      <div className="stat-cards">
        <div onClick={() => onNavigate("tasks")} style={{ cursor: "pointer" }}>
          <StatCard value={data.tasks.pending} label="Pending Tasks" />
        </div>
        <div onClick={() => onNavigate("alerts")} style={{ cursor: "pointer" }}>
          <StatCard value={alertTotal} label="Alerts (7d)" />
        </div>
        <StatCard value={data.memories.total} label="Memories" />
        <StatCard value={data.messages.last24h} label="Messages (24h)" />
      </div>

      {data.alerts.critical > 0 && (
        <div className="card" style={{ margin: "8px 12px", background: "#fff0f0" }}>
          <strong style={{ color: "#ff3b30" }}>
            {data.alerts.critical} critical alert{data.alerts.critical > 1 ? "s" : ""} this week
          </strong>
        </div>
      )}

      <div className="section-header">Active Groups</div>
      <div className="card">
        {(data.groups || []).length === 0 ? (
          <EmptyState message="No active groups" />
        ) : (
          data.groups.map((g) => (
            <div key={g.chat_id} className="group-item">
              <span className="name">{g.chat_title || `Chat ${g.chat_id}`}</span>
              <span className="weight">x{g.priority_weight?.toFixed(1)}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
