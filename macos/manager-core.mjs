export function isTunnelId(value) {
  return /^tunnel_[0-9a-f]{32}$/.test(value);
}

export function profileName(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error('Invalid account ID');
  return `account-${id}`;
}

export function createReadOnlyConfig(roots) {
  return createAccessConfig(roots);
}

export function createAccessConfig(roots, { write = false, commands = false, screenView = false, screenControl = false } = {}, current = {}) {
  if (write && roots.length === 0) throw new Error('Select a folder before enabling file writes.');
  if (screenControl && !screenView) throw new Error('Enable screen view before screen control.');
  return {
    ...current,
    http: { ...current.http, host: '127.0.0.1', port: 3210 },
    filesystem: { ...current.filesystem, read: roots.length > 0, write, roots },
    shell: { ...current.shell, enabled: commands, ...(commands ? { allowedCommands: ['*'], allowEnvironment: false } : {}) },
    jobs: current.jobs ?? { enabled: false },
    desktop: { ...current.desktop, hostDisplayAccess: screenView, screenCapture: screenView, input: screenControl, screenRecording: current.desktop?.screenRecording ?? false },
  };
}

export function pollAgeSeconds(metrics, nowSeconds = Date.now() / 1000) {
  const match = metrics.match(/^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+([0-9.eE+-]+)/m);
  if (!match) return null;
  const age = nowSeconds - Number(match[1]);
  return Number.isFinite(age) && age >= -5 && age <= 60 ? Math.round(age) : null;
}
