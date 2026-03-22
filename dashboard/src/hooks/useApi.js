import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "../api/client";

export function useApi(path) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(pathRef.current)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(path)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  return { data, loading, error, refetch };
}
