import React, { useState } from "react";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Tasks from "./pages/Tasks";
import Alerts from "./pages/Alerts";
import Summaries from "./pages/Summaries";

export default function App() {
  const [tab, setTab] = useState("dashboard");

  return (
    <Layout tab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard onNavigate={setTab} />}
      {tab === "tasks" && <Tasks />}
      {tab === "alerts" && <Alerts />}
      {tab === "summaries" && <Summaries />}
    </Layout>
  );
}
