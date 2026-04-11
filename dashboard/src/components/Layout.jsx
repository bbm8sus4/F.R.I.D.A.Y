import React from "react";

const TABS = [
  { id: "dashboard", icon: "📊", label: "Dashboard" },
  { id: "tasks", icon: "📋", label: "Tasks" },
  { id: "alerts", icon: "🔔", label: "Alerts" },
  { id: "summaries", icon: "📝", label: "Summaries" },
  { id: "costs", icon: "💰", label: "Costs" },
];

export default function Layout({ tab, onTabChange, children }) {
  return (
    <div className="app">
      <div className="header">
        <h1>{new URLSearchParams(window.location.search).get("api")?.includes("daisy") ? "Daisy" : new URLSearchParams(window.location.search).get("api")?.includes("sigma") ? "Sigma" : "Friday"} Dashboard</h1>
      </div>
      {children}
      <div className="bottom-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => onTabChange(t.id)}
          >
            <span className="icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
