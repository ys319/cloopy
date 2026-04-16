import { dim } from "@std/fmt/colors";

/**
 * Display elapsed time for long-running operations.
 * Writes elapsed seconds to stderr using `\r` overwrite.
 * @param label Prefix text shown before the timer
 * @returns Object with a `stop()` method to clear the timer line
 */
export function startTimer(label: string): { stop: () => void } {
  const start = Date.now();
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const time = min > 0 ? `${min}:${String(sec).padStart(2, "0")}` : `${sec}s`;
    Deno.stderr.writeSync(
      new TextEncoder().encode(`\r  ${label} ${dim(time)}`),
    );
  }, 1000);

  return {
    stop() {
      clearInterval(interval);
      // Clear the timer line
      Deno.stderr.writeSync(
        new TextEncoder().encode("\r" + " ".repeat(60) + "\r"),
      );
    },
  };
}
