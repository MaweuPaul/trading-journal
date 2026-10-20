// Server-wide overload guard. The per-visitor rate limit stops one visitor
// hammering the API, but many visitors at once can still swamp the single
// instance. When too many requests are already in progress, or the event loop
// is falling behind (CPU saturated), new requests get a quick 503 with
// Retry-After instead of piling up until the instance runs out of memory or
// every request times out.
//
//   MAX_IN_FLIGHT        requests handled at once before refusing (default 200)
//   MAX_EVENT_LOOP_LAG_MS event-loop delay that counts as overloaded (default 1000)
const { monitorEventLoopDelay } = require('perf_hooks');

function createLoadShedder({ maxInFlight = 200, maxLagMs = 1000, sampleMs = 1000, retryAfterSec = 5, exempt = () => false } = {}) {
  let inFlight = 0;
  let peakInFlight = 0;
  let shed = 0;
  let lagMs = 0;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    lagMs = histogram.mean / 1e6; // ns -> ms, averaged over the last sample
    histogram.reset();
  }, sampleMs);
  timer.unref();

  function middleware(req, res, next) {
    if (exempt(req)) return next();
    if (inFlight >= maxInFlight || lagMs > maxLagMs) {
      shed += 1;
      res.set('Retry-After', String(retryAfterSec));
      return res.status(503).json({ error: 'The server is busy right now. Try again in a few seconds.' });
    }
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  }

  function stats() {
    return { inFlight, peakInFlight, maxInFlight, shed, eventLoopLagMs: Math.round(lagMs), maxLagMs };
  }

  function stop() {
    clearInterval(timer);
    histogram.disable();
  }

  return { middleware, stats, stop };
}

module.exports = { createLoadShedder };
