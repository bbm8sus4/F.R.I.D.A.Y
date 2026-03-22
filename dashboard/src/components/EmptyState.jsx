import React from "react";

export default function EmptyState({ message }) {
  return (
    <div className="empty-state">
      <p>{message || "No data"}</p>
    </div>
  );
}
