// Builds Island.exe and installs it for the current user:
//   %LOCALAPPDATA%\Programs\Island   the app
//   %APPDATA%\Island\config.json     settings (copied from ./config.json the first time)
//   Start menu + desktop shortcuts, and it starts with Windows.
// Run: npm run install-app
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packager } = require('@electron/packager');
const { pillPng } = require('../src/icon');

const ROOT = path.join(__dirname, '..');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const INSTALL_DIR = path.join(LOCAL, 'Programs', 'Island');
const USER_DATA = path.join(ROAMING, 'Island');
const EXE = path.join(INSTALL_DIR, 'Island.exe');

// An .ico may hold a PNG directly, so wrap the generated pill.
function writeIcon(file) {
  const png = pillPng(256);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // width 256
  header.writeUInt8(0, 7); // height 256
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(file, Buffer.concat([header, png]));
}

function ps(script) {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'inherit' });
}

async function main() {
  const build = path.join(ROOT, 'build');
  fs.mkdirSync(build, { recursive: true });
  const icon = path.join(build, 'icon.ico');
  writeIcon(icon);

  console.log('Packaging…');
  const [out] = await packager({
    dir: ROOT,
    out: path.join(build, 'out'),
    name: 'Island',
    executableName: 'Island',
    platform: 'win32',
    arch: 'x64',
    icon,
    overwrite: true,
    asar: false, // the media helper is compiled and run from inside the app folder
    prune: true,
    appCopyright: 'Island',
    win32metadata: { FileDescription: 'Island', ProductName: 'Island', CompanyName: 'Island' },
    ignore: [/^\/build($|\/)/, /^\/test($|\/)/, /^\/docs($|\/)/, /^\/bin($|\/)/, /^\/config\.json$/, /^\/\.git($|\/)/],
  });

  console.log('Installing to', INSTALL_DIR);
  // Close a running copy (installed or dev) so files aren't locked.
  ps(
    "Get-Process Island, island-media -ErrorAction SilentlyContinue | Stop-Process -Force; " +
      `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${ROOT.replace(/'/g, "''")}*' } | Stop-Process -Force; Start-Sleep -Milliseconds 800`,
  );
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  fs.cpSync(out, INSTALL_DIR, { recursive: true });

  fs.mkdirSync(USER_DATA, { recursive: true });
  const devConfig = path.join(ROOT, 'config.json');
  const userConfig = path.join(USER_DATA, 'config.json');
  if (!fs.existsSync(userConfig) && fs.existsSync(devConfig)) {
    fs.copyFileSync(devConfig, userConfig);
    console.log('Copied your settings to', userConfig);
  }

  const startMenu = path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Island.lnk');
  // Ask Windows for the Desktop: it's often redirected into OneDrive.
  const desktop = "(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Island.lnk')";
  const shortcut = (lnk) =>
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${lnk}); ` +
    `$s.TargetPath = '${EXE}'; $s.WorkingDirectory = '${INSTALL_DIR}'; $s.IconLocation = '${EXE},0'; $s.Description = 'Island'; $s.Save();`;
  ps(shortcut(`'${startMenu.replace(/'/g, "''")}'`) + shortcut(desktop));

  // First launch registers "start with Windows" pointing at Island.exe.
  spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
  console.log('Installed and launched Island.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
