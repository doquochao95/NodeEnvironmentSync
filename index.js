#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const semver = require('semver');
const chalk = require('chalk');
const Table = require('cli-table3');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const https = require('https');
const AdmZip = require('adm-zip');

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else {
      fs.readdirSync(dir).forEach(f => {
        const cur = path.join(dir, f);
        if (fs.statSync(cur).isDirectory()) rmrf(cur);
        else fs.unlinkSync(cur);
      });
      fs.rmdirSync(dir);
    }
  }
}

// --- SYSTEM AND CONFIGURATION ---
const NGN_HOME = __dirname;
const NGN_VERSIONS = path.join(NGN_HOME, 'versions');
const NGN_CURRENT = path.join(NGN_HOME, 'current');
const compatibilityFile = path.join(NGN_HOME, 'compatibility.json');
const nesConfigFile = path.join(NGN_HOME, 'nes_config.json');

let compatibilityMatrix = {};
let nesConfig = { managed_packages: [] };

function loadConfigs() {
  if (fs.existsSync(compatibilityFile)) {
    try { compatibilityMatrix = JSON.parse(fs.readFileSync(compatibilityFile, 'utf8')); } catch (e) { }
  }
  if (fs.existsSync(nesConfigFile)) {
    try { nesConfig = JSON.parse(fs.readFileSync(nesConfigFile, 'utf8')); } catch (e) { }
  } else {
    fs.writeFileSync(nesConfigFile, JSON.stringify(nesConfig, null, 2));
  }
}

function saveNesConfig() {
  fs.writeFileSync(nesConfigFile, JSON.stringify(nesConfig, null, 2));
}

// Native HTTPS helpers
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Failed to parse JSON')); }
      });
    }).on('error', reject);
  });
}

function httpsDownloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Server returned status code ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
    }).on('error', (err) => {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

function recreateRl() {
  rl.close();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));
}

// --- DYNAMIC TOOL MANAGEMENT ---

function findBestVersion(pkgName, nodeVersion) {
  const toolMap = compatibilityMatrix[pkgName];
  if (!toolMap) return null;
  const sampleKey = Object.keys(toolMap)[0];
  if (!sampleKey) return null;

  const v = semver.coerce(nodeVersion);
  if (!v) return null;
  const majorNode = v.major;

  // Find the best version from highest node version that matches
  const nodeMajors = Object.keys(toolMap).map(Number).sort((a, b) => b - a);
  for (const m of nodeMajors) {
    if (majorNode >= m) {
      const pkgRange = toolMap[m];
      // If range satisfies current node version, return the range (semver will pick latest)
      if (semver.satisfies(nodeVersion, pkgRange)) {
        return semver.major(semver.minVersion(pkgRange).version);
      }
    }
  }
  return null;
}

function getToolPath(nodeDir, pkgName) {
  const parts = pkgName.includes('/') ? pkgName.split('/') : [pkgName];
  return path.join(nodeDir, 'node_modules', ...parts, 'package.json');
}

async function runExternalCommand(cmd, args, envAdditions = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envAdditions };
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: true, env });
    proc.on('close', code => resolve(code));
    proc.on('error', err => { console.error(chalk.red(`[Error] Error: ${err.message}`)); resolve(-1); });
  });
}

function getInstalledNodes() {
  if (!fs.existsSync(NGN_VERSIONS)) return [];
  return fs.readdirSync(NGN_VERSIONS).filter(d => {
    const fullPath = path.join(NGN_VERSIONS, d);
    if (!fs.statSync(fullPath).isDirectory()) return false;
    return semver.valid(d.replace(/^v/, ''));
  }).map(d => ({ path: path.join(NGN_VERSIONS, d), version: d }));
}

// --- CORE NODE.JS & TOOL INSTALLATION ---

async function installNodeTarget(version) {
  const cleanVer = semver.clean(version.startsWith('v') ? version : 'v' + version);
  if (!cleanVer) return console.log(chalk.red('Invalid version.'));

  const targetDir = path.join(NGN_VERSIONS, `v${cleanVer}`);
  if (fs.existsSync(targetDir)) return console.log(chalk.yellow(`\nNode.js v${cleanVer} already installed.`));

  const zipFile = path.join(NGN_HOME, `node-v${cleanVer}.zip`);
  const urls = [
    `https://nodejs.org/dist/v${cleanVer}/node-v${cleanVer}-win-x64.zip`,
    `https://nodejs.org/dist/v${cleanVer}/node-v${cleanVer}-x64.zip` // Legacy fallback
  ];

  console.log(chalk.cyan(`\nAttempting to download Node.js v${cleanVer}...`));

  let success = false;
  for (const dlUrl of urls) {
    try {
      console.log(chalk.gray(`  Source: ${dlUrl}`));
      await httpsDownloadFile(dlUrl, zipFile);
      success = true;
      break;
    } catch (err) {
      if (err.message.includes('404')) continue;
      return console.log(chalk.red(`\n[Error] Download Error: ${err.message}`));
    }
  }

  if (!success) return console.log(chalk.red(`\n[Error] Error: Version v${cleanVer} is listed but the ZIP files are not found on the server (404).`));

  try {
    const extractTemp = path.join(NGN_HOME, `temp_v${cleanVer}`);

    try {
      const zip = new AdmZip(zipFile);
      zip.extractAllTo(extractTemp, true);
    } catch (zipErr) {
      if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
      if (fs.existsSync(extractTemp)) rmrf(extractTemp);
      return console.log(chalk.red(`\n[Error] Error: Failed to extract (Invalid ZIP source for v${cleanVer})`));
    }

    const innerFolder = path.join(extractTemp, `node-v${cleanVer}-win-x64`);
    if (!fs.existsSync(innerFolder)) {
      if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
      if (fs.existsSync(extractTemp)) rmrf(extractTemp);
      return console.log(chalk.red(`\n[Error] Error: ZIP structure mismatch for v${cleanVer}`));
    }

    // SAFETY DELAY: Windows indexing/AV often locks new folders
    await new Promise(r => setTimeout(r, 1500));

    let moved = false;
    for (let attempts = 0; attempts < 3; attempts++) {
      try {
        if (attempts > 0) await new Promise(r => setTimeout(r, 1000));
        // Try rename first (fast), fallback to copy
        try { fs.renameSync(innerFolder, targetDir); }
        catch (e) { fs.cpSync(innerFolder, targetDir, { recursive: true }); }
        moved = true;
        break;
      } catch (err) {
        if (attempts === 2) throw err;
      }
    }

    if (!moved) throw new Error("Could not move extracted files after 3 attempts.");

    rmrf(extractTemp);
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
    console.log(chalk.green(`\n[OK] Successfully installed Node v${cleanVer}!`));

    // Auto-delete old versions with same major
    const newMajor = semver.major(cleanVer);
    const currentActive = fs.existsSync(NGN_CURRENT) ? fs.realpathSync(NGN_CURRENT) : '';
    const installed = getInstalledNodes();
    
    for (const node of installed) {
      const nodeVer = semver.clean(node.version);
      if (nodeVer === cleanVer) continue;
      if (semver.major(nodeVer) !== newMajor) continue;
      if (currentActive.includes(node.path)) continue;
      
      console.log(chalk.gray(`  Removing old v${nodeVer}...`));
      rmrf(node.path);
    }

    const npmCmd = path.join(targetDir, 'npm.cmd');
    for (const pkg of nesConfig.managed_packages) {
      const best = findBestVersion(pkg, cleanVer);
      if (best && fs.existsSync(npmCmd)) {
        await runExternalCommand(npmCmd, ['install', '-g', `${pkg}@${best}`, '--loglevel=error', '--no-fund', '--no-audit', '--force']);
      }
    }
  } catch (e) { console.log(chalk.red(`[Error] Error: ${e.message}`)); }
}

async function useNodeTarget(version) {
  const cleanVer = semver.clean(version.startsWith('v') ? version : 'v' + version);
  if (!cleanVer) return;
  const targetDir = path.join(NGN_VERSIONS, `v${cleanVer}`);
  if (!fs.existsSync(targetDir)) return console.log(chalk.red(`\nVersion not installed.`));

  try {
    if (fs.existsSync(NGN_CURRENT)) fs.unlinkSync(NGN_CURRENT);
    fs.symlinkSync(targetDir, NGN_CURRENT, 'junction');
    console.log(chalk.green(`\n[OK] Activated Node.js v${cleanVer}!`));
    console.log(chalk.gray(`(Note: Ensure '${NGN_CURRENT}' is in your PATH. Running 'nes --setup' can help.)`));
  } catch (e) { console.log(chalk.red(`\n[Error] Error: ${e.message}`)); }
}

async function uninstallNode(version) {
  const targetVer = version.startsWith('v') ? version : 'v' + version;
  const targetPath = path.join(NGN_VERSIONS, targetVer);
  if (!fs.existsSync(targetPath)) return;

  const currentPath = fs.existsSync(NGN_CURRENT) ? fs.realpathSync(NGN_CURRENT).toLowerCase() : '';
  if (currentPath === path.resolve(targetPath).toLowerCase()) return console.log(chalk.red('[Error] Cannot delete ACTIVE version.'));

  console.log(chalk.yellow(`\nUninstalling ${targetVer} (Safe Move)...`));

  // 1. Kill Node processes first - suppress ALL output
  const killCmd = `powershell -NoProfile -NonInteractive -Command "$null = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { \\$_.Path -like '${path.resolve(targetPath).replace(/'/g, "''")}*' } | Stop-Process -Force"`;
  execSync(killCmd, { stdio: 'ignore', windowsHide: true });

  await new Promise(r => setTimeout(r, 400));

  // 2. Move to .trash folder to instantly clear UI
  const trashBase = path.join(NGN_HOME, '.trash');
  if (!fs.existsSync(trashBase)) fs.mkdirSync(trashBase);
  const trashPath = path.join(trashBase, `${targetVer}_${Date.now()}`);

  try {
    fs.renameSync(targetPath, trashPath);
    console.log(chalk.green('[OK] Successfully uninstalled (Moved to trash)'));
  } catch (err) {
    // If move fails, try direct deletion as fallback - suppress ALL output
    const rmCmd = `powershell -NoProfile -NonInteractive -Command "$null = Remove-Item -Path '${targetPath}' -Recurse -Force -ErrorAction SilentlyContinue"`;
    execSync(rmCmd, { stdio: 'ignore', windowsHide: true });

    if (!fs.existsSync(targetPath)) console.log(chalk.green('[OK] Successfully uninstalled.'));
    else console.log(chalk.red('[Error] Lock persists. Please close all VS Code instances and try again.'));
  }

  // 3. Attempt silent background cleanup of trash (completely suppressed)
  try {
    if (fs.existsSync(trashBase)) {
      // Use hidden background process for cleanup to not block UI
      const silentRm = `powershell -NoProfile -NonInteractive -Command "$null = Remove-Item -Path '${trashBase}\\*' -Recurse -Force -ErrorAction SilentlyContinue"`;
      execSync(silentRm, { stdio: 'ignore', windowsHide: true });
    }
  } catch (e) { /* Silent skip */ }
}

async function doEnvironmentSync() {
  const tools = nesConfig.managed_packages;
  const table = new Table({
    head: [chalk.cyan('Major'), chalk.cyan('Recent'), ...tools.map(t => chalk.cyan(t)), chalk.cyan('Status')],
    chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '', 'left-mid': '', mid: '', 'mid-mid': '', right: '', 'right-mid': '', middle: ' ' },
    style: { head: ['cyan'], paddingLeft: 0, paddingRight: 1 }
  });
  const nodes = getInstalledNodes();
  const toFix = [];

  nodes.forEach(node => {
    const nodeVer = semver.clean(node.version);
    const majorVer = semver.major(nodeVer);
    const row = [`v${majorVer}`, nodeVer]; let allOk = true; const missing = [];
    tools.forEach(pkg => {
      const pkgPath = getToolPath(node.path, pkg);
      let curVer = null;
      if (fs.existsSync(pkgPath)) { try { curVer = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch (e) { } }
      const best = findBestVersion(pkg, nodeVer);
      const isOk = curVer && (semver.major(curVer) == best || best === null);
      row.push(curVer ? (isOk ? chalk.green(curVer) : chalk.yellow(curVer)) : chalk.gray('None'));
      if (!isOk && best) { allOk = false; missing.push(`${pkg}@${best}`); }
    });
    if (!allOk) {
      row.push(chalk.yellow(`Mismatch`));
      toFix.push({ nodeVer, dir: node.path, npmCmd: path.join(node.path, 'npm.cmd'), missing });
    } else row.push(chalk.green('[OK] Optimized'));
    table.push(row);
  });
  console.log(chalk.bold.magenta('\n=== ENVIRONMENT SYNC ==='));
  console.log(table.toString());

  if (toFix.length > 0 && (await askQuestion(chalk.cyan(`Fix ${toFix.length} environment(s)? (y/n): `))).toLowerCase() === 'y') {
    for (const s of toFix) {
      for (const m of s.missing) {
        await runExternalCommand(s.npmCmd, ['install', '-g', m, '--no-fund', '--no-audit', '--loglevel=error', '--force'], { PATH: `${s.dir};${process.env.PATH}` });
      }
    }
  }
}

function clearHost() {
  // Full terminal reset: clear screen, reset cursor, reset all attributes
  process.stdout.write('\u001b[2J\u001b[H\u001b[0m');
}

// --- INTERACTIVE SELECTOR ---

async function doNodeManager() {
  clearHost();
  const list = await httpsGetJSON('https://nodejs.org/dist/index.json');
  // ... (rest of logic)
  const majorMap = {};
  list.forEach(n => {
    const m = semver.major(semver.clean(n.version));
    const supportsWinZip = n.files && n.files.includes('win-x64-zip');
    if (supportsWinZip) {
      if (!majorMap[m] || semver.gt(semver.clean(n.version), semver.clean(majorMap[m].version))) majorMap[m] = n;
    } else if (!majorMap[m]) {
      majorMap[m] = { ...n, unsupported: true };
    }
  });
  const majors = Object.keys(majorMap).map(Number).sort((a, b) => b - a);
  let index = 0;
  let actionIndex = 0;

  const render = (msg = '', isSub = false) => {
    // Hide cursor
    process.stdout.write('\u001b[?25l');

    // Clear screen and reset cursor to home
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);

    let output = '';
    output += chalk.bold.magenta('=== NODE.JS ENGINES MANAGER ===\n');
    const installed = getInstalledNodes();
    let curActive = null;
    try {
      if (fs.existsSync(NGN_CURRENT)) {
        const real = fs.realpathSync(NGN_CURRENT);
        curActive = semver.clean(path.basename(real));
      }
    } catch (e) { }

    const table = new Table({
      head: [chalk.cyan('Major'), chalk.cyan('Recent'), chalk.cyan('Online'), chalk.cyan('Status'), chalk.cyan('Date'), chalk.cyan('Note')],
      colWidths: [8, 14, 14, 18, 12, 12],
      chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '', 'left-mid': '', mid: '', 'mid-mid': '', right: '', 'right-mid': '', middle: ' ' },
      style: { head: ['cyan'], paddingLeft: 0, paddingRight: 1 }
    });

    majors.forEach((m, i) => {
      const n = majorMap[m];
      const onlineV = semver.clean(n.version);
      let status = chalk.gray('Not Installed'), note = '', prefix = (i === index) ? chalk.bold.magenta('>') : ' ';
      let recentVer = chalk.gray('-');
      const local = installed.find(l => semver.major(semver.clean(l.version)) === m);
      if (local) {
        const cleanL = semver.clean(local.version);
        recentVer = cleanL;
        status = cleanL === onlineV ? chalk.green('[Latest]') : chalk.yellow('[Update]');
        if (cleanL === curActive) note = chalk.green('Activated');
      } else if (n.unsupported) {
        status = chalk.red('[Unsupported]');
      }
      const row = [`${prefix} v${m}`, recentVer, onlineV, status, n.date || '-', note];
      if (i === index) table.push(row.map(c => chalk.bgWhite.black(c)));
      else table.push(row);
    });

    output += table.toString() + '\n';

    // UI MODAL LOGIC: Show Action or Controls on same line
    if (isSub) {
      const m = majors[index];
      const local = installed.find(l => semver.major(semver.clean(l.version)) === m);
      const opt1 = local ? 'Use' : 'Install';
      const act0 = actionIndex === 0 ? chalk.bgWhite.black('[1]' + opt1) : chalk.green('[1]' + opt1);
      const act1 = actionIndex === 1 ? chalk.bgWhite.black('[2]Update') : chalk.cyan('[2]Update');
      const act2 = actionIndex === 2 ? chalk.bgWhite.black('[3]Delete') : chalk.red('[3]Delete');
      output += act0 + ' ' + act1 + ' ' + act2 + String.raw`
`;
      output += chalk.yellow('[←/→]Nav ') + chalk.green('[Enter]Exec ') + chalk.gray('[Backspace]Return');
    } else {
      output += (msg ? msg + '  ' : '');
      output += chalk.yellow('[↑/↓]Nav ') + chalk.green('[Enter]Menu ') + chalk.gray('[Backspace]Return');
    }

    // Final atomic flush - add padding to clear old content
    readline.cursorTo(process.stdout, 0, 0);
    process.stdout.write(output);
    process.stdout.write('\u001b[?25h');
  };

  clearHost();

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    let isLocked = false;
    let subMenuMode = false;
    let statusMsg = '';

    const onKey = async (str, key) => {
      if (isLocked) return; // IGNORE all input when busy

      if (subMenuMode) {
        const m = majors[index]; const n = majorMap[m];
        const local = getInstalledNodes().find(l => semver.major(semver.clean(l.version)) === m);

        const confirmContinue = async () => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          while (process.stdin.read() !== null);
          process.stdin.resume();

          rl.write(null, { ctrl: true, name: 'u' });
          const ans = await new Promise(res => rl.question(chalk.cyan('\nContinue managing versions? (Y/n): '), res));

          if (ans === '' || ans.toLowerCase() === 'y') {
            clearHost(); // Aggressive clear
            await new Promise(r => setTimeout(r, 100)); // Sync pause
            statusMsg = '';
            process.stdin.setRawMode(true);
            process.stdin.resume();
            isLocked = false;
            subMenuMode = false;
            render();
            return true;
          }
          process.stdin.removeListener('keypress', onKey);
          recreateRl();
          resolve(); return false;
        };

        const isActionKey = key.name === 'return' || (key.name >= '1' && key.name <= '3');
        const keyAction = key.name === 'return' ? actionIndex : parseInt(key.name) - 1;
        
        if (isActionKey) {
          if (key.name >= '1' && key.name <= '3') actionIndex = parseInt(key.name) - 1;
          
          isLocked = true;
          process.stdin.setRawMode(false);

          try {
            if (keyAction === 0) {
              if (local) await useNodeTarget(local.version);
              else await installNodeTarget(n.version);
            } else if (keyAction === 1) {
              await installNodeTarget(n.version);
            } else if (keyAction === 2) {
              if (local) await uninstallNode(local.version);
              else console.log(chalk.red('[Warning] Not installed.'));
            }
          } catch (err) {
            console.log(chalk.red(`\n[Error] Action Error: ${err.message}`));
          } finally {
            await confirmContinue();
            isLocked = false;
            subMenuMode = false;
            actionIndex = 0;
          }
          return;
        } else if (key.name === 'left') {
          actionIndex = actionIndex > 0 ? actionIndex - 1 : 2;
          render('', true);
        } else if (key.name === 'right') {
          actionIndex = actionIndex < 2 ? actionIndex + 1 : 0;
          render('', true);
        } else if (key.name === 'backspace') {
          subMenuMode = false; statusMsg = '';
          clearHost();
          render();
        }
        return;
      }

      if (key.name === 'up') { index = (index > 0) ? index - 1 : majors.length - 1; render(statusMsg); }
      else if (key.name === 'down') { index = (index < majors.length - 1) ? index + 1 : 0; render(statusMsg); }
      else if (key.name === 'return') {
        const n = majorMap[majors[index]];
        if (n.unsupported) {
          statusMsg = chalk.red('[Warning] This legacy version has no portable ZIP for win-x64.');
          render(statusMsg);
        } else {
          subMenuMode = true;
          actionIndex = 0;
          render('', true);
        }
      }
      else if (key.name === 'backspace') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        recreateRl();
        resolve();
      }
    };
    process.stdin.on('keypress', onKey);
    render();
  });
}

// --- MAIN MENU ---

async function showMenu() {
  clearHost();
  loadConfigs();
  console.log(chalk.bold.magenta(`\n======================= NES =========================`));
  console.log(chalk.bold.magenta(`     NODE-ENVIRONMENT MANAGER (NES)      `));
  console.log(chalk.gray(`Storage Home: ${NGN_HOME}`));
  console.log(chalk.bold.magenta(`=====================================================`));
  console.log(chalk.cyan('1.') + ' Status: Environment Sync Dashboard');
  console.log(chalk.cyan('2.') + ' Manage: Node.js Engines (Arrows Navigation)');
  console.log(chalk.cyan('3.') + ' Plugins: Manage Managed Packages');
  console.log(chalk.cyan('4.') + ' Exit');
  console.log(chalk.bold.magenta('====================================================='));

  const choice = (await askQuestion(chalk.white('Choice (1-4): '))).trim();
  switch (choice) {
    case '1': clearHost(); await doEnvironmentSync(); break;
    case '2': await doNodeManager(); break;
    case '3':
      clearHost();
      console.log(chalk.bold.magenta('=== PLUGIN MANAGER ===\n'));
      nesConfig.managed_packages.forEach((p, i) => console.log(`${i + 1}. ${p}`));
      const cmd = await askQuestion(chalk.cyan('\nAdd package name, or "del <name>" to remove: '));
      if (cmd.startsWith('del ')) {
        const pDel = cmd.replace('del ', '').trim();
        nesConfig.managed_packages = nesConfig.managed_packages.filter(x => x !== pDel);
      } else if (cmd.trim()) {
        if (!nesConfig.managed_packages.includes(cmd.trim())) nesConfig.managed_packages.push(cmd.trim());
      }
      saveNesConfig(); break;
    case '4': clearHost(); rl.close(); process.exit(0);
    default: console.log(chalk.red('Invalid.'));
  }
  if (choice !== '2') await askQuestion(chalk.gray('\nEnter to return...'));
  showMenu();
}

loadConfigs();
showMenu();
