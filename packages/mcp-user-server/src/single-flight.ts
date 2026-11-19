// One in-flight connect per client. A second caller waits on the same attempt
// instead of opening another connection with the same auth key.

export function singleFlight(start: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  return () => {
    if (!inflight) {
      const run = start().finally(() => {
        if (inflight === run) inflight = undefined;
      });
      // A caller that timed out may drop this promise. The rejection must
      // still be observed, and a later await of the same promise still throws.
      run.catch(() => {});
      inflight = run;
    }
    return inflight;
  };
}
