import React, { useState, useEffect } from "react";
import { apiFetch } from "../api/client";
import StatCard from "../components/StatCard";
import EmptyState from "../components/EmptyState";

const PRICING = {
  "gemini-2.5-pro": { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 },
  "gemini-2.5-flash": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};
const DEFAULT_PRICING = PRICING["gemini-2.5-flash"];
const THB_RATE = 35;

const ALL_BOTS = [
  { name: "Friday", url: "https://my-ai-bot.friday-bot.workers.dev" },
  { name: "Daisy", url: "https://daisy-ai-bot.friday-bot.workers.dev" },
  { name: "Sigma", url: "https://sigma-ai-bot.friday-bot.workers.dev" },
];

function calcCost(inputTokens, outputTokens, model) {
  const p = PRICING[model] || DEFAULT_PRICING;
  return (inputTokens * p.input + outputTokens * p.output) * THB_RATE;
}

function formatTHB(amount) {
  if (amount < 1) return `฿${amount.toFixed(2)}`;
  return `฿${amount.toFixed(1)}`;
}

function BarChart({ data, labelKey, valueKey, formatValue }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d[valueKey]));
  if (max === 0) return null;
  return (
    <div className="bar-chart">
      {data.map((d, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label">{d[labelKey]}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(d[valueKey] / max) * 100}%` }} />
          </div>
          <span className="bar-value">{formatValue ? formatValue(d[valueKey]) : d[valueKey]}</span>
        </div>
      ))}
    </div>
  );
}

// Detect if this is Friday (host) dashboard
function isFridayHost() {
  const api = new URLSearchParams(window.location.search).get("api") || import.meta.env.VITE_API_URL || "";
  return !api || api.includes("my-ai-bot");
}

export default function Costs() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [botData, setBotData] = useState([]);
  const [view, setView] = useState("all"); // "all" or bot name

  useEffect(() => {
    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        if (isFridayHost()) {
          // Fetch from all bots
          const results = await Promise.allSettled(
            ALL_BOTS.map(async (bot) => {
              try {
                const data = await apiFetch("/api/costs", { baseUrl: bot.url });
                return { name: bot.name, data };
              } catch (e) {
                return { name: bot.name, data: null, error: e.message };
              }
            })
          );
          setBotData(results.map((r) => r.status === "fulfilled" ? r.value : { name: "?", data: null }));
        } else {
          // Single bot mode
          const data = await apiFetch("/api/costs");
          const api = new URLSearchParams(window.location.search).get("api") || "";
          const name = api.includes("daisy") ? "Daisy" : api.includes("sigma") ? "Sigma" : "Friday";
          setBotData([{ name, data }]);
        }
      } catch (e) {
        setError(e.message);
      }
      setLoading(false);
    }
    fetchAll();
  }, []);

  if (loading) return <div className="loading"><div className="spinner" /><p>Loading...</p></div>;
  if (error) return <div className="error-state">Error: {error}</div>;
  if (botData.length === 0) return <EmptyState message="No cost data yet" />;

  // Filter bots based on view
  const activeBots = view === "all" ? botData : botData.filter((b) => b.name === view);
  const showAllBots = isFridayHost() && botData.length > 1;

  // Aggregate costs across selected bots
  let totalToday = 0, totalWeek = 0, totalMonth = 0;
  const featureAgg = {};
  const dailyAgg = {};
  const botCosts = [];

  for (const bot of activeBots) {
    if (!bot.data) continue;
    const s = bot.data.summary || {};

    // Use byModel for accurate cost
    let botMonthCost = 0;
    for (const m of bot.data.byModel || []) {
      botMonthCost += calcCost(m.input_tokens, m.output_tokens, m.model);
    }

    // Today/week - estimate using byModel ratio
    const proRatio = (bot.data.byModel || []).find((m) => m.model?.includes("pro"));
    const defaultModel = proRatio ? "gemini-2.5-pro" : "gemini-2.5-flash";
    totalToday += calcCost(s.today_input || 0, s.today_output || 0, defaultModel);
    totalWeek += calcCost(s.week_input || 0, s.week_output || 0, defaultModel);
    totalMonth += botMonthCost;

    botCosts.push({ bot: bot.name, cost: botMonthCost });

    // By feature
    for (const f of bot.data.byFeature || []) {
      const key = view === "all" ? `${bot.name}:${f.feature}` : f.feature;
      if (!featureAgg[key]) featureAgg[key] = { feature: key, cost: 0, calls: 0 };
      featureAgg[key].cost += calcCost(f.input_tokens, f.output_tokens, f.model);
      featureAgg[key].calls += f.calls;
    }

    // Daily trend
    for (const d of bot.data.daily || []) {
      if (!dailyAgg[d.day]) dailyAgg[d.day] = { day: d.day, cost: 0 };
      dailyAgg[d.day].cost += calcCost(d.input_tokens, d.output_tokens, d.model);
    }
  }

  const featureChart = Object.values(featureAgg).sort((a, b) => b.cost - a.cost);
  const dailyChart = Object.values(dailyAgg).sort((a, b) => a.day.localeCompare(b.day));
  const botChart = botCosts.sort((a, b) => b.cost - a.cost);

  return (
    <>
      <div className="page-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Costs</span>
        {showAllBots && (
          <select
            value={view}
            onChange={(e) => setView(e.target.value)}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--hint)", background: "var(--bg)" }}
          >
            <option value="all">All Bots</option>
            {botData.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        )}
      </div>

      <div className="stat-cards">
        <StatCard value={formatTHB(totalToday)} label="Today" />
        <StatCard value={formatTHB(totalWeek)} label="7 Days" />
        <StatCard value={formatTHB(totalMonth)} label="30 Days" />
      </div>

      {showAllBots && view === "all" && (
        <>
          <div className="section-header">By Bot (30d)</div>
          <div className="card">
            {botChart.length === 0 ? (
              <EmptyState message="No data yet" />
            ) : (
              <BarChart data={botChart} labelKey="bot" valueKey="cost" formatValue={formatTHB} />
            )}
          </div>
        </>
      )}

      <div className="section-header">By Feature (30d)</div>
      <div className="card">
        {featureChart.length === 0 ? (
          <EmptyState message="No data yet" />
        ) : (
          <BarChart data={featureChart} labelKey="feature" valueKey="cost" formatValue={formatTHB} />
        )}
      </div>

      <div className="section-header">Daily Trend (14d)</div>
      <div className="card">
        {dailyChart.length === 0 ? (
          <EmptyState message="No data yet" />
        ) : (
          <BarChart data={dailyChart} labelKey="day" valueKey="cost" formatValue={formatTHB} />
        )}
      </div>
    </>
  );
}
