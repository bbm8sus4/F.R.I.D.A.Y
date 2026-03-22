import React from "react";

export default function FilterBar({ options, value, onChange }) {
  return (
    <div className="filter-bar">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`filter-chip ${value === opt.value ? "active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
