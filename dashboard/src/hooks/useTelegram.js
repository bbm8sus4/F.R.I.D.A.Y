import { useMemo } from "react";

export function useTelegram() {
  const tg = window.Telegram?.WebApp;
  const user = useMemo(() => tg?.initDataUnsafe?.user || null, [tg]);
  const colorScheme = tg?.colorScheme || "light";

  return { tg, user, colorScheme };
}
