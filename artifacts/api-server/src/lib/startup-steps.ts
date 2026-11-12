type StartupStep = { name: string; run: () => Promise<unknown> };

// Fail before the publishing supervisor terminates the process without context.
// The entrypoint must exit on rejection: a timed-out operation is not cancelled.
export async function runStartupSteps(steps: StartupStep[], timeoutMs = 20_000): Promise<void> {
  let activeStep = "initialization";
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`[startup] Timed out after ${timeoutMs} ms during "${activeStep}". Server was not opened; no readiness checks were bypassed.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        for (const step of steps) {
          if (expired) return;
          activeStep = step.name;
          const started = Date.now();
          console.log(`[startup] Starting: ${activeStep}`);
          await step.run();
          if (expired) return;
          console.log(`[startup] Completed: ${activeStep} (${Date.now() - started} ms)`);
        }
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}