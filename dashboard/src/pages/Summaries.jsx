import React, { useState } from "react";
import { useApi } from "../hooks/useApi";
import FilterBar from "../components/FilterBar";
import EmptyState from "../components/EmptyState";

const TYPE_OPTIONS = [
  { value: "", label: "All" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export default function Summaries() {
  const [type, setType] = useState("");
  const [chatId, setChatId] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page, limit: 20 });
  if (type) params.set("type", type);
  if (chatId) params.set("chat_id", chatId);
  if (search) params.set("search", search);

  const { data, loading, error } = useApi(`/api/summaries?${params}`);
  const { data: groups } = useApi("/api/groups");

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  const handleSearch = (e) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <>
      <div className="page-title">Summaries</div>

      <FilterBar
        options={TYPE_OPTIONS}
        value={type}
        onChange={(v) => { setType(v); setPage(1); }}
      />

      <div style={{ padding: "0 12px 8px", display: "flex", gap: 6 }}>
        <select
          className="search-input"
          value={chatId}
          onChange={(e) => { setChatId(e.target.value); setPage(1); }}
          style={{ flex: "0 0 auto", minWidth: 120 }}
        >
          <option value="">All groups</option>
          {groups?.data?.map((g) => (
            <option key={g.chat_id} value={g.chat_id}>{g.chat_title || g.chat_id}</option>
          ))}
        </select>
        <form onSubmit={handleSearch} style={{ flex: 1, display: "flex", gap: 6 }}>
          <input
            type="text"
            className="search-input"
            placeholder="Search summaries..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-primary" style={{ flexShrink: 0 }}>
            Search
          </button>
        </form>
      </div>

      {loading && <div className="loading"><div className="spinner" /><p>Loading...</p></div>}
      {error && <div className="error-state">Error: {error}</div>}

      {!loading && data?.data?.length === 0 && <EmptyState message="No summaries found" />}

      {!loading && data?.data?.map((s) => (
        <div key={s.id} className="summary-card">
          <div className="summary-header">
            <span className="summary-date">
              {s.summary_type === "daily" ? "📅" : "📆"} {s.summary_date}
            </span>
            <span className="summary-group">{s.chat_title}</span>
            <span className="summary-count">{s.message_count} msg</span>
          </div>
          <div className="summary-body">{s.summary_text}</div>
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
