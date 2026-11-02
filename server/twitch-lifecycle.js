/** Hourly validation plus proactive refresh; timers never run on the playable-round deadline. */
export function monitorTwitchAuth(
  api,
  {
    onFailure = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let stopped = false,
    expiry,
    hourly;
  const run = async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (!stopped) onFailure(error);
    }
  };
  const schedule = (state) => {
    if (stopped) return;
    if (state.status === "reauthorization-required") {
      clearTimer(expiry);
      return;
    }
    if (state.status !== "ready" || !Number.isFinite(state.refreshAt)) return;
    clearTimer(expiry);
    expiry = setTimer(
      () => {
        if (!stopped) void run(() => api.refresh("expiry"));
      },
      Math.max(1000, state.refreshAt - now()),
    );
    expiry.unref?.();
  };
  const validate = () => {
    hourly = setTimer(async () => {
      if (stopped) return;
      await run(() => api.validateToken("hourly"));
      if (!stopped) validate();
    }, 3600000);
    hourly.unref?.();
  };
  const unsubscribe = api.onAuthChange?.(schedule);
  if (api.authState) schedule(api.authState());
  validate();
  return () => {
    stopped = true;
    clearTimer(expiry);
    clearTimer(hourly);
    unsubscribe?.();
  };
}
