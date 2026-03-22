import React, { useState } from "react";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Commitments from "./pages/Commitments";
import Alerts from "./pages/Alerts";

export default function App() {
  const [tab, setTab] = useState("dashboard");

  return (
    <Layout tab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard onNavigate={setTab} />}
      {tab === "commitments" && <Commitments />}
      {tab === "alerts" && <Alerts />}
    </Layout>
  );
}
