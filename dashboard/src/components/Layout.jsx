import React from "react";

const TABS = [
  { id: "dashboard", icon: "📊", label: "Dashboard" },
  { id: "commitments", icon: "📋", label: "Pending" },
  { id: "alerts", icon: "🔔", label: "Alerts" },
];

export default function Layout({ tab, onTabChange, children }) {
  return (
    <div className="app">
      <div className="header">
        <h1>Friday Dashboard</h1>
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
