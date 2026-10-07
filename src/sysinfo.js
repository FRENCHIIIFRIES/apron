// CPU, memory, Wi-Fi and uptime for the System tab. (Battery comes from the renderer's
// navigator.getBattery, which also gives time remaining.)
const os = require('os');
const { execFile } = require('child_process');

function cpuTimes() {
  return os.cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

/** Parses `netsh wlan show interfaces`. */
function parseWifi(text) {
  const get = (key) => {
    const m = String(text).match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : null;
  };
  const state = get('State');
  if (!state || !/connected/i.test(state) || /disconnected/i.test(state)) return { connected: false };
  return { connected: true, ssid: get('SSID'), signal: parseInt(get('Signal') || '0', 10) || 0, band: get('Band') };
}

function wifi() {
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? { connected: false } : parseWifi(out)));
  });
}

function start(onUpdate) {
  let prev = cpuTimes();
  let net = { connected: false };
  let hot = 0;

  async function tick() {
    const now = cpuTimes();
    const idle = now.idle - prev.idle;
    const total = now.total - prev.total;
    prev = now;
    const cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    hot = cpu >= 90 ? hot + 1 : 0;
    const mem = { used: os.totalmem() - os.freemem(), total: os.totalmem() };
    onUpdate({ cpu, mem, wifi: net, uptime: os.uptime(), cpuHot: hot >= 5 }); // ~10s pegged
  }

  const refreshWifi = async () => {
    net = await wifi();
  };
  refreshWifi();
  const t1 = setInterval(tick, 2000);
  const t2 = setInterval(refreshWifi, 15000);
  return {
    stop() {
      clearInterval(t1);
      clearInterval(t2);
    },
  };
}

module.exports = { start, parseWifi };
