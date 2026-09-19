// How a game with friends is going, in a few words: shared by the host's bar (player.js) and a
// friend's (join.js).

export const ms = (n) => (n == null ? null : `${Math.round(n)} ms`);
export const frames = (n) => (n == null ? null : `${Math.round(n)} ${Math.abs(Math.round(n)) === 1 ? 'frame' : 'frames'}`);

/**
 * The time from a player's press to its taking effect on their screen, the round trip to the
 * server and back, how far behind the host a friend runs, and how often they stall (see stats
 * in public/player/netplay-fixes.js). `own`: the host's own line, which also says the delay,
 * what's being streamed and the mode.
 */
export function statsLine(st, { own = false } = {}) {
  if (!st) return '';
  const parts = [];
  if (st.lag != null) parts.push(`input lag ${ms(st.lag)}`);
  else if (own && st.delay != null) parts.push(`input delay ${frames(st.delay + 1)} (${ms((st.delay + 1) * 1000 / 60)})`);
  if (st.ping != null) parts.push(`${st.mode === 'stream' || st.videoFps != null ? 'presses' : 'ping'} ${ms(st.ping)}${st.transport ? ` ${st.transport === 'direct' ? 'direct' : st.transport === 'server' ? 'via the server' : 'partly direct'}` : ''}`);
  if (st.videoFps != null || st.videoKbps != null) parts.push(`video ${st.videoFps ?? '?'} fps${st.videoKbps != null ? `, ${(st.videoKbps / 1000).toFixed(1)} Mbps` : ''}${st.videoWidth ? `, ${st.videoWidth}×${st.videoHeight}` : ''}`);
  if (st.limited) parts.push(`encoder held back by ${st.limited}`);
  if (st.viewer?.jitterMs != null) parts.push(`their buffer ${ms(st.viewer.jitterMs)}`);
  if (own && st.source) parts.push(`streaming ${st.source.width}×${st.source.height}${st.audio ? ' with sound' : ', no sound captured'}`);
  if (st.ahead != null) parts.push(st.ahead > 0 ? `${frames(st.ahead)} behind` : st.ahead < 0 ? `${frames(-st.ahead)} ahead` : 'in step');
  if (st.stalls) parts.push(`${st.stalls} ${st.stalls === 1 ? 'stall' : 'stalls'} (${ms(st.stalled)})`);
  if (own && st.delay != null) parts.push(`delay ${frames(st.delay)}`);
  if (st.rollbacks) parts.push(`${st.rollbacks} ${st.rollbacks === 1 ? 'rollback' : 'rollbacks'}${st.rollbackFrames != null ? ` of ${frames(st.rollbackFrames)}` : ''}`);
  if (st.resyncs) parts.push(`${st.resyncs} ${st.resyncs === 1 ? 'resync' : 'resyncs'}`);
  if (own && st.mode) parts.push(st.mode);
  return parts.join(', ');
}
