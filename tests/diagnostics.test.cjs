const assert = require('node:assert/strict');
const { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { createServer } = require('node:http');
const { createServer: createHttpsServer } = require('node:https');
const { connect } = require('node:net');
const { promisify } = require('node:util');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function app() {
    const nodes = new Map();
    for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const classes = new Set();
        nodes.set(match[1], {
            value: '', checked: /\schecked(?:\s|>)/.test(match[0]), hidden: false,
            disabled: false, style: {}, textContent: '', innerHTML: '',
            addEventListener() {},
            classList: {
                contains: name => classes.has(name),
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                toggle: (name, on = !classes.has(name)) => on ? classes.add(name) : classes.delete(name),
            },
        });
    }
    nodes.get('deployment').value = 'github';
    nodes.get('plan').value = 'business';
    nodes.get('ghe-plan').value = 'business';
    nodes.get('path-environment').value = 'windows';
    nodes.get('path-shell').value = 'bash';
    nodes.get('path-vpn').value = 'unknown';
    const context = vm.createContext({
        URL, AbortController, performance, setTimeout, clearTimeout, console,
        navigator: { language: 'en', clipboard: { writeText: async () => {} } },
        localStorage: { getItem: () => null, setItem() {} },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
        document: {
            documentElement: { setAttribute() {} },
            getElementById: id => {
                assert.ok(nodes.has(id), `Missing DOM element: ${id}`);
                return nodes.get(id);
            },
            querySelectorAll: () => [],
            addEventListener() {},
        },
    });
    vm.runInContext(code, context);
    return {
        context, nodes,
        run: expression => vm.runInContext(expression, context),
        json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
        set(id, value) {
            nodes.get(id)[typeof value === 'boolean' ? 'checked' : 'value'] = value;
        },
    };
}

test('HTML IDs are unique and all translated UI keys exist in all languages', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size);
    const a = app();
    const translations = a.json('TRANSLATIONS');
    const keys = [...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map(match => match[1]);
    for (const language of ['en', 'ja', 'ko']) {
        assert.deepEqual(Object.keys(translations[language]).sort(), Object.keys(translations.en).sort());
        assert.ok(translations[language]['footer.verified'].includes(a.run('REVIEWED_AT')));
        for (const key of keys) assert.ok(translations[language][key], `${language}: ${key}`);
        a.run(`setLang('${language}')`);
        for (const guide of ['vscode', 'jetbrains', 'vs', 'xcode', 'cli', 'other']) {
            a.run(`currentIdeTab = '${guide}'; renderIdeGuide()`);
            assert.doesNotMatch(a.nodes.get('ide-content').innerHTML, /undefined/);
            for (const key of ['ide.docsLogs', 'ide.docsNetwork', 'ide.docsAuth', 'ide.docsVoice']) {
                assert.ok(a.nodes.get('ide-content').innerHTML.includes(translations[language][key]));
            }
        }
    }
});

test('GitHub.com includes authentication assets and makes reports and voice opt-in', () => {
    const a = app();
    const rules = () => a.json('getFirewallRules(getSelectedPlan(), getOptions())').map(rule => rule.domain);
    assert.ok(rules().includes('github.githubassets.com'));
    assert.ok(rules().includes('avatars.githubusercontent.com'));
    assert.ok(rules().includes('github.com/copilot/*'));
    assert.ok(!rules().some(host => /reports|azureml/.test(host)));
    a.set('opt-reports', true);
    a.set('opt-voice', true);
    for (const host of ['copilot-reports.github.com', 'copilot-reports-*.b01.azurefd.net',
        'usagereports*.blob.core.windows.net', 'ai.azure.com', '*.api.azureml.ms',
        'amlwlrt4*.blob.core.windows.net']) assert.ok(rules().includes(host), host);
    const endpoints = a.json('getTestableGroups()').flatMap(group => group.endpoints);
    assert.ok(endpoints.some(ep => ep.url === 'https://copilot-reports.github.com'));
    assert.ok(endpoints.every(ep => !ep.url.includes('*')));
    assert.ok(!endpoints.some(ep => ep.url.includes('eastus')));
});

test('apex GitHub domain stays client-scoped and Aspire stays cloud-agent-scoped', async () => {
    const a = app();
    for (const restricted of [false, true]) {
        a.set('opt-routing', restricted);
        const rules = a.json('getFirewallRules(getSelectedPlan(), getOptions())');
        assert.equal(rules.filter(rule => rule.domain === 'github.com').length, 1);
        assert.ok(!rules.some(rule => rule.domain === 'aspire.dev'));
        assert.match(a.run('buildFirewallRulesText()'), /\ngithub\.com # /);
        const targets = a.json('getPathTargets()');
        const apex = targets.find(target => target.url === 'https://github.com');
        assert.ok(apex);
        assert.equal(apex.expectedStatus, undefined);
        assert.ok(!targets.some(target => target.url.includes('aspire.dev')));
        for (const generator of [
            'generateBashScript()', 'generateBashScript("zsh")', 'generatePowerShellScript()',
            'generateWindowsPathScript()', 'generateUnixPathScript("linux")', 'generateUnixPathScript("macos", "zsh")',
        ]) {
            const script = a.run(generator);
            assert.ok(script.includes("'https://github.com'"), generator);
            assert.ok(!script.includes('aspire.dev'), generator);
        }
    }
    let copied = '';
    a.context.navigator.clipboard.writeText = async text => { copied = text; };
    await a.run('copyCloudAgentRules(document.getElementById("copy-script"))');
    assert.match(copied, /\n  aspire\.dev\n/);
    assert.ok(copied.includes(a.run('REVIEWED_AT')));
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'test-tenant');
    a.set('opt-public-code', false);
    assert.deepEqual(a.json('getFirewallRules(getSelectedPlan(), getOptions())').map(rule => rule.domain),
        ['test-tenant.ghe.com', '*.test-tenant.ghe.com']);
    assert.ok(a.json('getPathTargets()').every(target => !/^https:\/\/github\.com(?:\/|$)/.test(target.url)));
});

test('GHE.com replaces GitHub.com services, including generated HTTP and DNS targets', () => {
    const a = app();
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'test-tenant');
    a.set('opt-reports', true);
    a.set('opt-emu', true);
    a.set('opt-routing', true);
    a.set('opt-public-code', false);
    a.set('opt-dns', true);
    a.set('opt-cert', true);
    const rules = a.json('getFirewallRules(getSelectedPlan(), getOptions())');
    assert.deepEqual(rules.map(rule => rule.domain), ['test-tenant.ghe.com', '*.test-tenant.ghe.com']);
    const groups = a.json('getTestableGroups()');
    assert.ok(groups.flatMap(group => group.endpoints).every(ep => new URL(ep.url).hostname.endsWith('.test-tenant.ghe.com') ||
        new URL(ep.url).hostname === 'test-tenant.ghe.com'));
    assert.deepEqual(a.json('getScriptEndpoints()'), groups);
    for (const generator of ['generateBashScript()', 'generatePowerShellScript()']) {
        const script = a.run(generator);
        assert.match(script, /copilot-proxy\.test-tenant\.ghe\.com/);
        assert.doesNotMatch(script, /https:\/\/(?:api\.githubcopilot\.com|github\.com|api\.github\.com|default\.exp-tas\.com)/);
        assert.doesNotMatch(script, /check_dns 'github\.com'|Test-DNS 'github\.com'/);
    }
    a.set('opt-public-code', true);
    assert.ok(a.json('getTestableGroups()').some(group => group.name === 'Public code detection'));
    a.run('refreshConfiguration()');
    assert.equal(a.nodes.get('github-options').hidden, true);
    assert.equal(a.nodes.get('plan-input').hidden, false);
    assert.equal(a.nodes.get('ghe-plan').hidden, false);
    assert.equal(a.nodes.get('ghe-plan-note').hidden, false);
});

test('GHE.com preserves independent plan selections without changing tenant rules', () => {
    const a = app();
    a.set('plan', 'pro-plus');
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'example');
    a.run('refreshConfiguration()');
    assert.equal(a.run('getSelectedPlan()'), 'business');
    assert.equal(a.nodes.get('plan-label').htmlFor, 'ghe-plan');
    const before = a.json('getFirewallRules(getSelectedPlan(), getOptions())');
    a.set('ghe-plan', 'enterprise');
    a.run('refreshConfiguration()');
    assert.deepEqual(a.json('getFirewallRules(getSelectedPlan(), getOptions())'), before);
    assert.match(a.run('buildFirewallRulesText()'), /User plan: enterprise \(context only/);
    for (const generator of ['generateBashScript()', 'generatePowerShellScript()']) {
        assert.match(a.run(generator), /# Plan: enterprise \(context only/);
        assert.match(a.run(generator), /allowed routing groups: not supported on GHE.com/);
    }
    a.set('deployment', 'github');
    a.run('refreshConfiguration()');
    assert.equal(a.run('getSelectedPlan()'), 'pro-plus');
    assert.equal(a.nodes.get('ghe-plan-note').hidden, true);
    assert.equal(a.nodes.get('plan-label').htmlFor, 'plan');
    a.set('deployment', 'ghe');
    a.run('refreshConfiguration()');
    assert.equal(a.run('getSelectedPlan()'), 'enterprise');
});

test('restricted routing supports all seven nonempty subscription group combinations', () => {
    const a = app();
    a.set('opt-routing', true);
    for (let selection = 1; selection < 8; selection++) {
        const individual = !!(selection & 1), business = !!(selection & 2), enterprise = !!(selection & 4);
        a.set('routing-individual', individual);
        a.set('routing-business', business);
        a.set('routing-enterprise', enterprise);
        const rules = a.json('getFirewallRules(getSelectedPlan(), getOptions())');
        assert.ok(!rules.some(rule => rule.domain === '*.githubcopilot.com/*'));
        assert.equal(rules.find(rule => rule.domain === '*.individual.githubcopilot.com').tag, individual ? 'routing-allow' : 'routing-block');
        assert.equal(rules.find(rule => rule.domain === '*.business.githubcopilot.com').tag, business ? 'routing-allow' : 'routing-block');
        assert.equal(rules.find(rule => rule.domain === '*.enterprise.githubcopilot.com').tag, enterprise ? 'routing-allow' : 'routing-block');
        assert.ok(!a.json('getTestableGroups()').flatMap(group => group.endpoints).some(ep => ep.url === 'https://api.githubcopilot.com/_ping'));
        const [allow, block] = a.run('buildFirewallRulesText()').split('\nBLOCK (not allowlist entries)\n');
        for (const [key, selected] of [['individual', individual], ['business', business], ['enterprise', enterprise]]) {
            const domain = `*.${key}.githubcopilot.com`;
            assert.equal(allow.includes(domain), selected);
            assert.equal((block || '').includes(domain), !selected);
        }
        const expectedGroups = ['individual', 'business', 'enterprise'].filter((_, index) => selection & (1 << index));
        assert.deepEqual(a.json('getOptions().routingPlans'), expectedGroups);
        for (const generator of ['generateBashScript()', 'generatePowerShellScript()']) {
            assert.ok(a.run(generator).includes(`allowed routing groups: ${expectedGroups.join(', ')}`));
        }
    }
    a.set('routing-individual', false);
    a.set('routing-business', false);
    a.set('routing-enterprise', false);
    assert.equal(a.run('configurationError(getOptions())'), 'config.routingError');
    a.run('refreshConfiguration()');
    assert.equal(a.nodes.get('copy-firewall').disabled, true);
    a.set('opt-routing', false);
    a.run('refreshConfiguration()');
    assert.equal(a.nodes.get('copy-firewall').disabled, false);
    assert.ok(a.json('getFirewallRules(getSelectedPlan(), getOptions())').some(rule => rule.domain === '*.githubcopilot.com/*'));
});

test('all current plan labels are selectable without inventing Student routing', () => {
    const a = app();
    for (const plan of ['free', 'student', 'pro', 'pro-plus', 'max', 'business', 'enterprise']) {
        assert.ok(html.includes(`value="${plan}"`), plan);
        a.set('plan', plan);
        assert.ok(a.json('getFirewallRules(getSelectedPlan(), getOptions())').some(rule => rule.domain === '*.githubcopilot.com/*'));
    }
    assert.doesNotMatch(code, /\*\.student\.githubcopilot\.com/);
});

test('invalid configuration clears stale outputs and disables export/run actions', () => {
    const a = app();
    a.set('deployment', 'ghe');
    for (const slug of ['', '-tenant', 'tenant-', 'a'.repeat(64), 'example.ghe.com', 'x"><script>', '$(touch nope)']) {
        a.set('ghe-subdomain', slug);
        a.run('refreshConfiguration()');
        assert.equal(a.nodes.get('config-error').hidden, false);
        for (const id of ['btn-run', 'copy-script', 'download-script', 'copy-firewall']) assert.equal(a.nodes.get(id).disabled, true, id);
        assert.doesNotMatch(a.nodes.get('script-content').textContent, /check_url/);
        assert.throws(() => a.run('getTestableGroups()'));
    }
    a.set('ghe-subdomain', 'a');
    a.run('refreshConfiguration()');
    assert.equal(a.nodes.get('btn-run').disabled, false);
    a.set('deployment', 'github');
    a.set('opt-emu', true);
    assert.equal(a.run('configurationError(getOptions())'), 'config.emuError');
    a.set('emu-slug', 'valid-enterprise');
    assert.ok(a.json('getTestableGroups()')[0].endpoints.some(ep => ep.url.endsWith('/enterprises/valid-enterprise/')));
});

test('proxy input is validated and never embeds credentials into scripts', () => {
    const a = app();
    for (const proxy of ['https://proxy:8080', 'http://user:password@proxy:8080',
        'http://proxy/path',         'http://proxy?secret=1', 'http://proxy#fragment',
        'http://proxy/$(id)']) {
        a.set('proxy-url', proxy);
        assert.equal(a.run('configurationError(getOptions())'), 'config.proxyError', proxy);
    }
    a.set('proxy-url', 'http://proxy.corp:8080');
    a.set('opt-proxy-script', true);
    assert.match(a.run('generateBashScript()'), /--proxy 'http:\/\/proxy\.corp:8080'/);
    assert.match(a.run('generatePowerShellScript()'), /-Proxy 'http:\/\/proxy\.corp:8080'/);
    assert.doesNotMatch(a.run('generateBashScript()'), /echo.*\$var = \$val/);
    assert.doesNotMatch(a.run('generatePowerShellScript()'), /Write-Host.*\$var = \$val/);
});

test('browser distinguishes completion, slow requests, timeout and transport failure without health claims', async () => {
    const a = app();
    let now = 0;
    a.context.performance = { now: () => now };
    a.context.fetch = async () => { now += 100; return { type: 'opaque', status: 0 }; };
    assert.equal((await a.run("checkEndpoint('https://example.com')")).status, 'pass');
    a.context.fetch = async () => { now += 3001; return { type: 'opaque' }; };
    assert.equal((await a.run("checkEndpoint('https://example.com')")).status, 'warn');
    a.context.fetch = async () => { throw new TypeError('Failed to fetch'); };
    assert.equal((await a.run("checkEndpoint('https://example.com')")).error, 'Network error');
    a.context.fetch = async () => { const error = new Error(); error.name = 'AbortError'; throw error; };
    assert.equal((await a.run("checkEndpoint('https://example.com')")).error, 'Timeout (8s)');
    assert.match(a.run("TRANSLATIONS.en['results.info']"), /cannot inspect HTTP status/);
});

test('export keeps run-time metadata instead of current selections', () => {
    const a = app();
    a.run(`currentRun = { timestamp: '2026-10-02T00:00:00Z', deployment: 'original.ghe.com' };
        currentResults = [{ group: 'Tenant', url: 'https://original.ghe.com', status: 'fail', error: 'Network error' }];`);
    a.set('deployment', 'github');
    const text = a.run('buildResultsText()');
    assert.match(text, /original\.ghe\.com/);
    assert.match(text, /does not identify the cause as a firewall block/);
});

test('cloud agent snapshot includes documented additions and no duplicate hosts', () => {
    const hosts = Object.values(app().json('CLOUD_AGENT_ALLOWLIST')).flat();
    assert.equal(hosts.length, new Set(hosts).size);
    for (const host of ['nugetregistryv2prod.blob.core.windows.net',
        'storage.googleapis.com/chrome-for-testing-public', 'keyserver.ubuntu.com',
        'download.opensuse.org', '172.18.0.1', 'repo.grails.org', 'aspire.dev']) assert.ok(hosts.includes(host), host);
});

function withTemp(fn) {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-diagnostics-test-'));
    try { return fn(directory); }
    finally { rmSync(directory, { recursive: true, force: true }); }
}

test('generated Bash syntax and HTTP classification, including exact slow threshold', () => withTemp(directory => {
    const a = app();
    const mock = join(directory, 'curl');
    writeFileSync(mock, '#!/bin/sh\nprintf "%s %s %s" "$MOCK_HTTP" "$MOCK_TIME" "$MOCK_TLS"\nexit "$MOCK_EXIT"\n', { mode: 0o755 });
    const scriptPath = join(directory, 'check.sh');
    for (const verbose of [false, true]) {
        a.set('opt-verbose', verbose);
        const script = a.run('generateBashScript()');
        writeFileSync(scriptPath, script);
        assert.equal(spawnSync('bash', ['-n', scriptPath]).status, 0);
        for (const [http, elapsed, exit, fail, warn] of [
            ['200', '0.1', '0', false, false],
            ['200', '3.0', '0', false, false],
            ['200', '3.001', '0', false, true],
            ['401', '0.1', '0', true, true],
            ['403', '0.1', '0', true, true],
            ['407', '0.1', '0', true, false],
            ['500', '0.1', '0', true, false],
            ['000', '0', '60', true, false],
            ['200', '0.1', '28', true, false],
            ['', '0', '6', true, false],
        ]) {
            const result = spawnSync('bash', [scriptPath], {
                encoding: 'utf8',
                env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_HTTP: http, MOCK_TIME: elapsed, MOCK_TLS: '0', MOCK_EXIT: exit },
            });
            assert.equal(result.status, fail ? 1 : 0, `${http}/${elapsed}/${exit}\n${result.stdout}\n${result.stderr}`);
            if (warn) assert.match(result.stdout, /WARN/);
            if (exit === '0' && Number(http) >= 400) assert.doesNotMatch(result.stdout, /PASS health/);
        }
    }
    a.set('opt-dns', true);
    a.set('opt-cert', true);
    a.set('opt-proxy-script', true);
    writeFileSync(scriptPath, a.run('generateBashScript()'));
    assert.equal(spawnSync('bash', ['-n', scriptPath]).status, 0);
}));

const powerShellExecutable = process.env.DIAGNOSTICS_POWERSHELL || 'pwsh';
const powerShellVersion = spawnSync(powerShellExecutable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
const hasPowerShell = powerShellVersion.status === 0;
const hasZsh = spawnSync('zsh', ['--version']).status === 0;
test('PowerShell is installed in CI', { skip: !process.env.CI }, () => {
    assert.ok(hasPowerShell, powerShellVersion.stderr);
    if (process.env.DIAGNOSTICS_POWERSHELL === 'powershell') assert.match(powerShellVersion.stdout, /^5\.1\./);
    if (process.env.DIAGNOSTICS_POWERSHELL === 'pwsh') assert.match(powerShellVersion.stdout, /^7\./);
});
test('Zsh is installed in Unix CI', { skip: !process.env.CI || process.platform === 'win32' }, () => assert.ok(hasZsh));

test('basic and advanced script controls copy and download their own content and reject invalid inputs', async () => {
    const a = app();
    a.run('globalThis.downloads = []; dl = (...args) => downloads.push(args)');
    a.context.navigator.clipboard.writeText = async text => { a.context.copied = text; };
    for (const [tab, name, extension] of [
        ['bash', 'copilot-network-check', 'sh'],
        ['zsh', 'copilot-network-check', 'zsh'],
        ['powershell', 'copilot-network-check', 'ps1'],
        ['path', 'copilot-path-check', 'ps1'],
    ]) {
        const advanced = tab === 'path';
        if (!advanced) a.run(`currentScriptTab = '${tab}'`);
        a.run('renderScript()');
        const contentId = advanced ? 'path-script-content' : 'script-content';
        const buttonId = advanced ? 'copy-path-script' : 'copy-script';
        const argument = advanced ? ", 'path'" : '';
        await a.run(`copyScript(document.getElementById('${buttonId}')${argument})`);
        assert.equal(a.context.copied, a.nodes.get(contentId).textContent);
        a.run(`downloadScript(false${argument})`);
        assert.equal(a.json('downloads.at(-1)')[1], a.nodes.get(contentId).textContent);
        a.run(`downloadScript(true${argument})`);
        assert.equal(a.json('downloads.at(-1)')[1], a.nodes.get(contentId).textContent);
        const downloads = a.json('downloads.slice(-2)');
        assert.deepEqual(downloads.map(item => item[0]), [`${name}.${extension}`, `${name}.txt`]);
        assert.equal(a.run('currentScriptTab'), advanced ? 'powershell' : tab);
        assert.doesNotMatch(a.nodes.get('script-content').textContent, /Windows path diagnostics/);
        assert.match(a.nodes.get('path-script-content').textContent, /Windows path diagnostics/);
    }
    a.set('proxy-url', 'http://user:secret@proxy.invalid');
    a.run("refreshConfiguration(); downloadScript(true); downloadScript(true, 'path')");
    assert.equal(a.json('downloads').length, 8);
    for (const id of ['copy-script', 'download-script', 'download-script-txt',
        'copy-path-script', 'download-path-script', 'download-path-script-txt']) assert.equal(a.nodes.get(id).disabled, true);
});

test('collapsed OS-specific diagnostics use current scope, redacted targets, and opt-in direct checks', () => {
    const a = app();
    const details = html.match(/<details[^>]*id="advanced-diagnostics"[^>]*>/)[0];
    assert.doesNotMatch(details, /\bopen\b/);
    assert.ok(!a.nodes.has('path-tab'));
    a.run('renderScript()');
    assert.match(a.run('generateWindowsPathScript()'), /\$includeDirect = \$false/);
    assert.equal(a.nodes.get('path-proxy-notice').hidden, false);
    assert.equal(a.nodes.get('path-direct-note').hidden, true);
    a.set('path-direct', true);
    a.set('path-environment', 'windows');
    a.set('path-vpn', 'on');
    a.set('proxy-url', 'http://private-proxy.invalid:8080');
    a.run('renderScript()');
    assert.equal(a.nodes.get('path-proxy-notice').hidden, true);
    assert.equal(a.nodes.get('path-direct-note').hidden, false);
    const script = a.run('generateWindowsPathScript()');
    assert.match(script, /\$includeDirect = \$true/);
    assert.match(script, /environment = 'windows'/);
    assert.match(script, /state = 'on'/);
    assert.doesNotMatch(script, /--insecure|--location|Set-ItemProperty|SetEnvironmentVariable|ExecutionPolicy Bypass/);
    a.set('opt-emu', true);
    a.set('emu-slug', 'private-enterprise');
    assert.ok(a.json('getPathTargets()').some(target =>
        target.url.includes('private-enterprise') && !target.displayTarget.includes('private-enterprise')));
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'private-tenant');
    a.set('ghe-plan', 'enterprise');
    a.set('opt-public-code', false);
    const targets = a.json('getPathTargets()');
    assert.equal(targets.length, 2);
    assert.ok(targets.every(target => target.url.includes('private-tenant') && !target.displayTarget.includes('private-tenant')));
    assert.ok(targets.every(target => !target.expectedStatus));
    assert.match(a.run('generateWindowsPathScript()'), /userPlan = 'enterprise'/);
});

const pathMainMarker = 'if (!(Test-WindowsHost)) {';

test('OS selection updates advanced content, instructions, copy, and download independently of basic tabs', async () => {
    const a = app();
    const scripts = new Map();
    a.run('globalThis.downloads = []; dl = (...args) => downloads.push(args)');
    a.context.navigator.clipboard.writeText = async text => { a.context.copied = text; };
    const selector = html.match(/<select[^>]*id="path-environment"[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...selector.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['windows', 'linux', 'macos']);
    for (const language of ['en', 'ja', 'ko']) {
        for (const os of ['windows', 'linux', 'macos']) {
            a.set('path-environment', os);
            a.run(`setLang('${language}'); renderScript()`);
            const extension = os === 'windows' ? 'ps1' : 'sh';
            assert.equal(a.nodes.get('path-extension').textContent, `(.${extension})`);
            assert.equal(a.nodes.get('path-command').textContent, os === 'windows' ? '.\\copilot-path-check.ps1' : 'bash ./copilot-path-check.sh');
            assert.equal(a.nodes.get('path-clues').textContent, a.run(`t('path.clues.${os}')`));
            await a.run("copyScript(document.getElementById('copy-path-script'), 'path')");
            assert.equal(a.context.copied, a.nodes.get('path-script-content').textContent);
            if (scripts.has(os)) assert.equal(a.context.copied, scripts.get(os), 'Language selection must not alter executable content or report fields');
            else scripts.set(os, a.context.copied);
            a.run("downloadScript(false, 'path'); downloadScript(true, 'path')");
            const downloads = a.json('downloads.slice(-2)');
            assert.deepEqual(downloads.map(item => item[0]), [`copilot-path-check.${extension}`, 'copilot-path-check.txt']);
            assert.ok(downloads.every(item => item[1] === a.nodes.get('path-script-content').textContent));
            assert.equal(a.run('currentScriptTab'), 'bash');
            if (os !== 'windows') {
                assert.match(a.context.copied, /^#!\/bin\/bash/);
                assert.doesNotMatch(a.context.copied, /curl\.exe|HKCU:|Test-WindowsHost/);
                assert.match(a.context.copied, new RegExp(`"environment": "${os}"`));
            }
        }
    }
});

test('Zsh selection uses native scripts, matching file commands, and separate Windows settings', async () => {
    const a = app();
    a.run('globalThis.downloads = []; dl = (...args) => downloads.push(args)');
    a.context.navigator.clipboard.writeText = async text => { a.context.copied = text; };
    for (const language of ['en', 'ja', 'ko']) {
        a.run(`setLang('${language}'); currentScriptTab = 'zsh'; renderScript()`);
        assert.equal(a.nodes.get('basic-shell-help').hidden, false);
        assert.equal(a.nodes.get('basic-shell-command').textContent, 'zsh ./copilot-network-check.zsh');
        assert.match(a.nodes.get('script-content').textContent, /^#!\/bin\/zsh/);
        a.run('downloadScript()');
        assert.equal(a.json('downloads.at(-1)')[0], 'copilot-network-check.zsh');
        for (const os of ['linux', 'macos', 'windows']) {
            a.set('path-environment', os);
            a.set('path-shell', 'zsh');
            a.run('renderScript()');
            assert.equal(a.nodes.get('path-shell-options').hidden, os === 'windows');
            assert.equal(a.nodes.get('path-command').textContent, os === 'windows' ? '.\\copilot-path-check.ps1' : 'zsh ./copilot-path-check.zsh');
            const content = a.nodes.get('path-script-content').textContent;
            if (os !== 'windows') {
                assert.match(content, /^#!\/bin\/zsh/);
                assert.doesNotMatch(content, /BASH_REMATCH|local status|for route in \$routes/);
            } else {
                assert.match(content, /Test-WindowsHost/);
            }
            await a.run("copyScript(document.getElementById('copy-path-script'), 'path')");
            assert.equal(a.context.copied, content);
            a.run("downloadScript(false, 'path'); downloadScript(true, 'path')");
            assert.deepEqual(a.json('downloads.slice(-2)').map(item => item[0]), [
                `copilot-path-check.${os === 'windows' ? 'ps1' : 'zsh'}`, 'copilot-path-check.txt',
            ]);
            assert.ok(a.json('downloads.slice(-2)').every(item => item[1] === content));
        }
        a.run("currentScriptTab = 'powershell'; renderScript()");
        assert.equal(a.nodes.get('basic-shell-help').hidden, true);
        assert.equal(a.nodes.get('path-shell').value, 'zsh');
    }
});

function unixPathMocks(directory) {
    writeFileSync(join(directory, 'uname'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_OS"\n', { mode: 0o755 });
    writeFileSync(join(directory, 'scutil'), `#!/bin/sh
if [ "$MOCK_SCUTIL_FAIL" = 1 ]; then echo private-error >&2; exit 1; fi
cat <<'PROXY'
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : private-proxy.invalid
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://private-pac.invalid/config.pac
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 0
    }
  }
}
PROXY
`, { mode: 0o755 });
    writeFileSync(join(directory, 'curl'), `#!/bin/sh
if [ "$2" = --version ]; then
    if [ "$MOCK_CURL_UNUSABLE" = 1 ]; then exit 1; fi
    echo 'curl 8.10.0 fixture'; exit 0
fi
explicit=false; proxy=''; bypass=unset
while [ "$#" -gt 0 ]; do
    case "$1" in
        --proxy) explicit=true; proxy="$2"; shift ;;
        --noproxy) bypass="$2"; shift ;;
    esac
    shift
done
http=200; connect=000; rc=0
if [ "$explicit" = true ]; then
    if [ -n "$proxy" ]; then
        connect=200
        if [ "$bypass" != '' ]; then exit 97; fi
    elif [ "$bypass" != '*' ]; then exit 98
    fi
elif [ "$MOCK_DEFAULT_FAIL" = 1 ]; then http=000; rc=28
fi
if [ -n "$MOCK_HTTP" ]; then http="$MOCK_HTTP"; fi
if [ -n "$MOCK_CONNECT" ]; then connect="$MOCK_CONNECT"; fi
if [ -n "$MOCK_EXIT" ]; then rc="$MOCK_EXIT"; fi
tls=0
if [ -n "$MOCK_TLS" ]; then tls="$MOCK_TLS"; fi
if [ "$MOCK_INVALID" = 1 ]; then printf 'private raw output'
else printf '%s|%s|%s|0.01|0.02|0.03|0.04' "$http" "$connect" "$tls"
fi
exit "$rc"
`, { mode: 0o755 });
}

function runUnixPathFixture(directory, a, os, env = {}, shell = 'bash') {
    const path = join(directory, shell === 'zsh' ? 'check.zsh' : 'check.sh');
    const before = new Set(readdirSync(directory));
    writeFileSync(path, a.run(`generateUnixPathScript('${os}', '${shell}')`));
    const syntax = spawnSync(shell, ['-n', path], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const result = spawnSync(shell, [path], {
        cwd: directory, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_OS: os === 'macos' ? 'Darwin' : 'Linux', ...env },
    });
    const files = readdirSync(directory).filter(name => /^copilot-path-check-.*\.json$/.test(name) && !before.has(name));
    assert.equal(files.length, 1, result.stdout + result.stderr);
    return { ...result, report: JSON.parse(readFileSync(join(directory, files[0]), 'utf8')) };
}

test('Linux and macOS path scripts produce redacted route comparisons and platform-specific clues', () => withTemp(directory => {
    unixPathMocks(directory);
    const a = app();
    a.set('proxy-url', 'http://private-proxy.invalid:8080');
    a.set('opt-emu', true);
    a.set('emu-slug', 'private-enterprise');
    a.set('path-direct', true);
    for (const os of ['linux', 'macos']) {
        const result = runUnixPathFixture(directory, a, os, { MOCK_DEFAULT_FAIL: '1', HTTPS_PROXY: 'http://private-env.invalid' });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.report.environment, os);
        assert.deepEqual(result.report.plannedRoutes, ['environment-default', 'designated-proxy', 'direct-authorized']);
        assert.equal(result.report.summary.collectionComplete, true);
        assert.ok(result.report.interpretations.some(item => item.signal === 'designated-proxy-succeeded-where-curl-default-failed'));
        assert.ok(result.report.environmentPresence.some(item => item.name === 'HTTPS_PROXY' && item.isSet));
        assert.doesNotMatch(JSON.stringify(result.report), /private-/);
        const clues = result.report.systemProxyClues;
        assert.equal(clues.status, os === 'macos' ? 'read' : 'not-collected');
        assert.equal(clues.httpProxyEnabled, os === 'macos' ? true : null);
        assert.equal(clues.httpsProxyEnabled, os === 'macos' ? false : null);
        assert.equal(clues.autoDiscoveryEnabled, null);
    }
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'private-tenant');
    a.set('opt-public-code', false);
    for (const os of ['linux', 'macos']) {
        const result = runUnixPathFixture(directory, a, os);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.report.results.every(item => item.finding === 'http-response-only'));
        assert.doesNotMatch(JSON.stringify(result.report), /private-/);
    }
    const denied = runUnixPathFixture(directory, a, 'macos', { MOCK_SCUTIL_FAIL: '1' });
    assert.equal(denied.status, 2);
    assert.equal(denied.report.summary.collectionComplete, false);
    assert.deepEqual(denied.report.collectionErrors, ['macos-system-proxy-read-error']);
    a.set('proxy-url', '');
    a.set('path-direct', false);
    const defaultOnly = runUnixPathFixture(directory, a, 'linux');
    assert.equal(defaultOnly.status, 2);
    assert.deepEqual(defaultOnly.report.plannedRoutes, ['environment-default']);
    for (const [env, error] of [
        [{ MOCK_OS: 'Darwin' }, 'selected-os-mismatch'],
        [{ MOCK_CURL_UNUSABLE: '1' }, 'curl-unavailable-or-unusable'],
    ]) {
        const result = runUnixPathFixture(directory, a, 'linux', env);
        assert.equal(result.status, 1);
        assert.deepEqual(result.report.collectionErrors, [error]);
        assert.equal(result.report.results.length, 0);
    }
}));

test('Unix path scripts distinguish CONNECT, TLS, HTTP, and malformed metrics', () => withTemp(directory => {
    unixPathMocks(directory);
    const a = app();
    a.set('proxy-url', 'http://proxy.invalid:8080');
    a.run(`getPathTargets = () => [{id:'fixture', url:'https://fixture.invalid/_ping',
        displayTarget:'https://fixture.invalid/_ping', purpose:'Health', expectedStatus:200}]`);
    for (const [os, shell] of [['linux', 'bash'], ['macos', 'bash'], ...(hasZsh ? [['linux', 'zsh'], ['macos', 'zsh']] : [])]) {
        for (const [env, finding, tls, exit] of [
            [{ MOCK_CONNECT: '407', MOCK_HTTP: '000', MOCK_EXIT: '56' }, 'proxy-authentication-required', 'unknown', 1],
            [{ MOCK_CONNECT: '403', MOCK_HTTP: '000', MOCK_EXIT: '56' }, 'proxy-connect-rejected', 'unknown', 1],
            [{ MOCK_EXIT: '5', MOCK_HTTP: '000' }, 'proxy-dns-failed', 'unknown', 1],
            [{ MOCK_EXIT: '6', MOCK_HTTP: '000' }, 'dns-failed', 'unknown', 1],
            [{ MOCK_EXIT: '7', MOCK_HTTP: '000' }, 'connection-failed', 'unknown', 1],
            [{ MOCK_CONNECT: '200', MOCK_EXIT: '60', MOCK_HTTP: '000', MOCK_TLS: '20' }, 'certificate-verification-failed', 'verification-failed', 1],
            [{ MOCK_CONNECT: '200', MOCK_EXIT: '35', MOCK_HTTP: '000' }, 'tls-handshake-failed', 'handshake-failed', 1],
            [{ MOCK_CONNECT: '200', MOCK_EXIT: '28', MOCK_HTTP: '000' }, 'request-timeout', 'unknown', 1],
            [{ MOCK_INVALID: '1' }, 'missing-or-invalid-http-observation', 'unknown', 1],
            [{ MOCK_HTTP: '302' }, 'unexpected-health-http-status', 'verified-by-curl', 1],
            [{ MOCK_HTTP: '403' }, 'unexpected-health-http-status', 'verified-by-curl', 1],
            [{ MOCK_HTTP: '200', MOCK_CONNECT: '200' }, 'expected-health-http-status', 'verified-by-curl', 0],
        ]) {
            const result = runUnixPathFixture(directory, a, os, env, shell);
            assert.equal(result.status, exit, `${os}/${shell}/${finding}: ${result.stdout}\n${result.stderr}`);
            assert.ok(result.report.results.every(item => item.finding === finding && item.tls === tls), JSON.stringify(result.report.results));
            assert.doesNotMatch(JSON.stringify(result.report), /private raw output/);
        }
    }
}));

function pathScriptWithMocks(a, overrides) {
    const script = a.run('generateWindowsPathScript()');
    assert.equal(script.split(pathMainMarker).length, 2);
    return script.replace(pathMainMarker, `${overrides}\n${pathMainMarker}`);
}

const pathMocks = `
function Test-WindowsHost { return $true }
function Get-Command { [pscustomobject]@{ Source = 'mock-curl' } }
function Test-Path { return $true }
function Get-ItemProperty {
    if ($env:MOCK_REGISTRY -eq 'error') { throw 'private-registry-error' }
    if ($env:MOCK_REGISTRY -eq 'absent') { return [pscustomobject]@{} }
    [pscustomobject]@{
        AutoConfigURL = 'http://private-pac.invalid/secret.pac'
        ProxyEnable = 1; ProxyServer = 'private-manual-proxy:8080'
        ProxyOverride = 'private-bypass'; AutoDetect = 1
    }
}
function Invoke-PathCurl {
    param([string]$Executable, [string[]]$CurlArguments)
    if ($CurlArguments[0] -eq '--version') {
        return [pscustomobject]@{ exitCode = 0; output = 'curl 8.10.0 fixture'; runnerTimedOut = $false }
    }
    $exitCode = 0
    $http = '200'
    $connect = '000'
    $tls = '0'
    if ($CurlArguments -contains '--proxy') {
        $index = [Array]::IndexOf($CurlArguments, '--proxy')
        if ($CurlArguments[$index + 1]) {
            $connect = '200'
            $noProxy = [Array]::IndexOf($CurlArguments, '--noproxy')
            if ($noProxy -lt 0 -or $CurlArguments[$noProxy + 1] -ne '') { throw 'NO_PROXY override missing' }
        } elseif ($CurlArguments -notcontains '*') { throw 'Direct authorization not applied' }
    } elseif ($env:MOCK_DEFAULT_FAIL -eq '1') { $exitCode = 28; $http = '000' }
    if ($env:MOCK_HTTP) { $http = $env:MOCK_HTTP }
    if ($env:MOCK_EXIT) { $exitCode = [int]$env:MOCK_EXIT }
    if ($env:MOCK_CONNECT) { $connect = $env:MOCK_CONNECT }
    if ($env:MOCK_TLS) { $tls = $env:MOCK_TLS }
    $output = "$http|$connect|$tls|0.01|0.02|0.03|0.04"
    if ($env:MOCK_INVALID -eq '1') { $output = 'private raw output' }
    [pscustomobject]@{ exitCode = $exitCode; output = $output; runnerTimedOut = ($env:MOCK_TIMEOUT -eq '1') }
}
`;

function runPathFixture(directory, script, env = {}) {
    const scriptPath = join(directory, 'path.ps1');
    const before = new Set(readdirSync(directory));
    writeFileSync(scriptPath, script);
    const result = spawnSync(powerShellExecutable, ['-NoProfile', '-File', scriptPath], {
        cwd: directory, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env },
    });
    const reports = readdirSync(directory).filter(name => /^copilot-path-check-.*\.json$/.test(name) && !before.has(name));
    assert.equal(reports.length, 1, result.stdout + result.stderr);
    return { ...result, report: JSON.parse(readFileSync(join(directory, reports[0]), 'utf8')) };
}

test('Windows path script writes redacted route comparisons and configuration clues', { skip: !hasPowerShell }, () => withTemp(directory => {
    const a = app();
    a.set('proxy-url', 'http://private-proxy.invalid:8080');
    a.set('opt-emu', true);
    a.set('emu-slug', 'private-enterprise');
    a.set('path-direct', true);
    a.set('path-environment', 'windows');
    a.set('path-vpn', 'on');
    const script = pathScriptWithMocks(a, pathMocks);
    const result = runPathFixture(directory, script, {
        MOCK_DEFAULT_FAIL: '1', HTTPS_PROXY: 'http://user:private-password@private-env-proxy.invalid',
        NODE_EXTRA_CA_CERTS: '/private/ca/path', NO_PROXY: 'private-bypass',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(result.report.plannedRoutes, ['environment-default', 'designated-proxy', 'direct-authorized']);
    assert.equal(result.report.summary.collectionComplete, true);
    assert.equal(result.report.summary.copilotRecovery, 'not verified');
    assert.ok(result.report.interpretations.some(item => item.signal === 'designated-proxy-succeeded-where-curl-default-failed'));
    assert.equal(result.report.windowsProxyClues.pacUrlConfigured, true);
    assert.equal(result.report.windowsProxyClues.manualProxyEnabled, true);
    assert.ok(result.report.environmentPresence.some(item => item.name === 'HTTPS_PROXY' && item.isSet));
    assert.doesNotMatch(JSON.stringify(result.report), /private-|\/private\//);
    a.set('deployment', 'ghe');
    a.set('ghe-subdomain', 'private-tenant');
    a.set('opt-public-code', false);
    const ghe = runPathFixture(directory, pathScriptWithMocks(a, pathMocks), { MOCK_REGISTRY: 'absent' });
    assert.equal(ghe.status, 0, ghe.stdout + ghe.stderr);
    assert.equal(ghe.report.windowsProxyClues.pacUrlConfigured, null);
    assert.ok(ghe.report.results.every(item => item.expectedHttpStatus === null && item.finding === 'http-response-only'));
    assert.doesNotMatch(JSON.stringify(ghe.report), /private-|\/private\//);
    const denied = runPathFixture(directory, pathScriptWithMocks(a, pathMocks), { MOCK_REGISTRY: 'error' });
    assert.equal(denied.status, 2);
    assert.equal(denied.report.summary.collectionComplete, false);
    assert.deepEqual(denied.report.collectionErrors, ['windows-proxy-settings-read-error']);
    assert.doesNotMatch(denied.stdout + JSON.stringify(denied.report), /private-registry-error/);
    a.set('proxy-url', '');
    a.set('path-direct', false);
    const defaultOnly = runPathFixture(directory, pathScriptWithMocks(a, pathMocks));
    assert.equal(defaultOnly.status, 2);
    assert.deepEqual(defaultOnly.report.plannedRoutes, ['environment-default']);
    assert.ok(defaultOnly.report.interpretations.some(item => item.signal === 'designated-proxy-not-tested'));
}));

test('Windows path classification separates CONNECT, TLS, HTTP and missing observations', { skip: !hasPowerShell }, () => withTemp(directory => {
    const a = app();
    a.set('proxy-url', 'http://proxy.invalid:8080');
    a.run(`getPathTargets = () => [{id:'fixture', url:'https://fixture.invalid/_ping',
        displayTarget:'https://fixture.invalid/_ping', purpose:'Health', expectedStatus:200}]`);
    const script = pathScriptWithMocks(a, pathMocks);
    for (const [env, finding, tls, exit] of [
        [{ MOCK_CONNECT: '407', MOCK_HTTP: '000', MOCK_EXIT: '56' }, 'proxy-authentication-required', 'unknown', 1],
        [{ MOCK_CONNECT: '403', MOCK_HTTP: '000', MOCK_EXIT: '56' }, 'proxy-connect-rejected', 'unknown', 1],
        [{ MOCK_EXIT: '5', MOCK_HTTP: '000' }, 'proxy-dns-failed', 'unknown', 1],
        [{ MOCK_EXIT: '6', MOCK_HTTP: '000' }, 'dns-failed', 'unknown', 1],
        [{ MOCK_EXIT: '7', MOCK_HTTP: '000' }, 'connection-failed', 'unknown', 1],
        [{ MOCK_CONNECT: '200', MOCK_EXIT: '60', MOCK_HTTP: '000', MOCK_TLS: '20' }, 'certificate-verification-failed', 'verification-failed', 1],
        [{ MOCK_CONNECT: '200', MOCK_EXIT: '35', MOCK_HTTP: '000' }, 'tls-handshake-failed', 'handshake-failed', 1],
        [{ MOCK_CONNECT: '200', MOCK_EXIT: '28', MOCK_HTTP: '000' }, 'request-timeout', 'unknown', 1],
        [{ MOCK_TIMEOUT: '1', MOCK_HTTP: '000' }, 'runner-timeout', 'unknown', 1],
        [{ MOCK_INVALID: '1' }, 'missing-or-invalid-http-observation', 'unknown', 1],
        [{ MOCK_HTTP: '302' }, 'unexpected-health-http-status', 'verified-by-curl', 1],
        [{ MOCK_HTTP: '403' }, 'unexpected-health-http-status', 'verified-by-curl', 1],
        [{ MOCK_HTTP: '200', MOCK_CONNECT: '200' }, 'expected-health-http-status', 'verified-by-curl', 0],
    ]) {
        const result = runPathFixture(directory, script, env);
        assert.equal(result.status, exit, `${finding}: ${result.stdout}\n${result.stderr}`);
        assert.ok(result.report.results.every(item => item.finding === finding), JSON.stringify(result.report.results));
        assert.ok(result.report.results.every(item => item.tls === tls), finding);
        assert.doesNotMatch(JSON.stringify(result.report), /private raw output/);
    }
    a.run(`getPathTargets = () => [{id:'fixture', url:'https://fixture.invalid',
        displayTarget:'https://fixture.invalid', purpose:'Reachability'}]`);
    const generic = runPathFixture(directory, pathScriptWithMocks(a, pathMocks), { MOCK_HTTP: '401' });
    assert.equal(generic.status, 2);
    assert.ok(generic.report.results.every(item => item.finding === 'authentication-policy-or-path-response'));
}));

test('Windows path script reports blocked prerequisites instead of probing another environment', { skip: !hasPowerShell }, () => withTemp(directory => {
    const a = app();
    for (const [mock, expected] of [
        ['function Test-WindowsHost { return $false }', 'windows-host-required'],
        ['function Test-WindowsHost { return $true }\nfunction Get-WindowsProxyClues { return @{} }\nfunction Get-Command { throw "private lookup error" }', 'curl-unavailable-or-unusable'],
    ]) {
        const result = runPathFixture(directory, pathScriptWithMocks(a, mock));
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.deepEqual(result.report.collectionErrors, [expected]);
        assert.equal(result.report.results.length, 0);
        assert.equal(result.report.summary.collectionComplete, false);
    }
}));

test('native path scripts force designated proxy despite NO_PROXY and preserve direct opt-in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-path-proxy-'));
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { encoding: 'utf8' });
    const sockets = new Set();
    let origin, proxy;
    try {
        assert.equal(certificate.status, 0, certificate.stderr);
        let originRequests = 0, connectRequests = 0, denyProxy = false;
        origin = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_, response) => {
            originRequests++;
            response.end('local health fixture');
        });
        proxy = createServer();
        proxy.on('connect', (request, socket, head) => {
            connectRequests++;
            if (denyProxy) {
                socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                return;
            }
            const upstream = connect(origin.address().port, '127.0.0.1', () => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                socket.pipe(upstream);
                upstream.pipe(socket);
            });
            sockets.add(upstream);
            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
            socket.on('close', () => upstream.destroy());
            upstream.on('close', () => sockets.delete(upstream));
        });
        for (const server of [origin, proxy]) {
            server.on('connection', socket => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        }
        const url = `https://127.0.0.1:${origin.address().port}/health`;
        const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
        const a = app();
        a.set('proxy-url', proxyUrl);
        a.set('path-direct', true);
        a.run(`getPathTargets = () => [{id:'local-health', url:'${url}', displayTarget:'local-health', purpose:'Health', expectedStatus:200}]`);
        const runners = [];
        if (hasPowerShell) {
            const nativeCurl = spawnSync(powerShellExecutable, ['-NoProfile', '-Command',
                `(Get-Command ${process.platform === 'win32' ? 'curl.exe' : 'curl'} -CommandType Application | Select-Object -First 1).Source`], { encoding: 'utf8' });
            assert.equal(nativeCurl.status, 0, nativeCurl.stderr);
            runners.push([powerShellExecutable, ['-NoProfile', '-File'], pathScriptWithMocks(a, `
${process.platform === 'win32' ? '' : 'function Test-WindowsHost { return $true }'}
function Get-WindowsProxyClues { return @{ status = 'fixture' } }
function Get-Command { [pscustomobject]@{ Source = '${nativeCurl.stdout.trim().replaceAll("'", "''")}' } }
# Trust only the loopback fixture certificate; do not modify the OS trust store.
$fixtureCurl = \${function:Invoke-PathCurl}
function Invoke-PathCurl {
    param([string]$Executable, [string[]]$CurlArguments)
    & $fixtureCurl $Executable ($CurlArguments + @('--cacert', '${cert.replaceAll('\\', '/').replaceAll("'", "''")}'))
}
`)]);
        }
        if (['linux', 'darwin'].includes(process.platform)) {
            runners.push(['bash', [], a.run(`generateUnixPathScript('${process.platform === 'darwin' ? 'macos' : 'linux'}')`)]);
            if (hasZsh) runners.push(['zsh', ['-f'], a.run(`generateUnixPathScript('${process.platform === 'darwin' ? 'macos' : 'linux'}', 'zsh')`)]);
        }
        for (const [command, args, script] of runners) {
            const path = join(directory, command === powerShellExecutable ? 'native.ps1' : command === 'zsh' ? 'native.zsh' : 'native.sh');
            writeFileSync(path, script);
            for (const [noProxy, reject, expectedConnect, expectedOrigin] of [
                ['*', false, 1, 3],
                ['', false, 2, 3],
                ['*', true, 1, 2],
            ]) {
                denyProxy = reject;
                const beforeFiles = new Set(readdirSync(directory));
                const previousConnect = connectRequests, previousOrigin = originRequests;
                const result = await promisify(execFile)(command, [...args, path], {
                    cwd: directory, timeout: 30000,
                    env: { ...process.env, CURL_CA_BUNDLE: cert,
                        HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '',
                        HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: noProxy, no_proxy: noProxy },
                }).then(value => ({ ...value, code: 0 }), error => error);
                assert.equal(result.code, reject ? 1 : 0, `${command}: ${result.stdout}\n${result.stderr}`);
                assert.doesNotMatch(result.stderr, /Report incomplete/);
                assert.equal(connectRequests - previousConnect, expectedConnect);
                assert.equal(originRequests - previousOrigin, expectedOrigin);
                const file = readdirSync(directory).find(name => name.endsWith('.json') && !beforeFiles.has(name));
                assert.ok(file, result.stdout + result.stderr);
                const report = JSON.parse(readFileSync(join(directory, file), 'utf8'));
                assert.equal(report.results.length, 3);
                assert.equal(report.results.find(item => item.route === 'direct-authorized').proxyConnectStatus, null);
                const explicit = report.results.find(item => item.route === 'designated-proxy');
                assert.equal(explicit.proxyConnectStatus, reject ? 407 : 200);
                assert.equal(explicit.httpStatus, reject ? null : 200);
                assert.equal(explicit.tls, reject ? 'unknown' : 'verified-by-curl');
            }
        }
    } finally {
        for (const socket of sockets) socket.destroy();
        for (const server of [proxy, origin]) if (server?.listening) await new Promise(resolve => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('generated PowerShell parses and classifies HTTP/transport failures', { skip: !hasPowerShell }, () => withTemp(directory => {
    const a = app();
    const scriptPath = join(directory, 'check.ps1');
    const mock = `function Invoke-WebRequest {
        param($Uri, [switch]$UseBasicParsing, $MaximumRedirection, $TimeoutSec, $Proxy, $ErrorAction)
        if ($env:MOCK_TRANSPORT -eq '1') { throw [System.Net.Http.HttpRequestException]::new('Simulated transport failure') }
        [pscustomobject]@{ StatusCode = [int]$env:MOCK_HTTP }
    }\n`;
    for (const verbose of [false, true]) {
        a.set('opt-verbose', verbose);
        writeFileSync(scriptPath, mock + a.run('generatePowerShellScript()'));
        for (const [http, transport, failed] of [['200', '0', false], ['401', '0', true],
            ['403', '0', true], ['407', '0', true], ['500', '0', true], ['0', '1', true]]) {
            const result = spawnSync(powerShellExecutable, ['-NoProfile', '-File', scriptPath], {
                encoding: 'utf8', env: { ...process.env, MOCK_HTTP: http, MOCK_TRANSPORT: transport },
            });
            assert.equal(result.status, failed ? 1 : 0, `${http}/${transport}\n${result.stdout}\n${result.stderr}`);
            if (transport === '1') assert.match(result.stdout, /FAIL transport/);
            else if (Number(http) >= 400) assert.doesNotMatch(result.stdout, /PASS health/);
        }
    }
    a.set('opt-dns', true);
    a.set('opt-cert', true);
    a.set('opt-proxy-script', true);
    writeFileSync(scriptPath, a.run('generatePowerShellScript()'));
    const result = spawnSync(powerShellExecutable, ['-NoProfile', '-Command',
        `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors) { $errors | Out-String | Write-Host; exit 1 }`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
}));

test('generated scripts classify real HTTP replies without following health redirects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-diagnostics-http-'));
    let health = 200, other = 200;
    const server = createServer((request, response) => {
        response.statusCode = request.url === '/health' ? health : other;
        if (response.statusCode === 302) response.setHeader('Location', '/redirect-target');
        response.end('diagnostic fixture');
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const a = app();
        a.run(`getScriptEndpoints = () => [{name: 'Local fixture', endpoints: [
            {url: '${base}/health', purpose: 'Health', expectedStatus: 200},
            {url: '${base}/other', purpose: 'Reachability'}
        ]}]`);
        const runners = [['bash', 'generateBashScript()', []]];
        if (hasZsh) runners.push(['zsh', 'generateBashScript("zsh")', ['-f']]);
        if (hasPowerShell) runners.push([powerShellExecutable, 'generatePowerShellScript()', ['-NoProfile', '-File']]);
        for (const [command, generator, args] of runners) {
            const path = join(directory, command === 'bash' ? 'real.sh' : 'real.ps1');
            writeFileSync(path, a.run(generator));
            for (const [healthCode, otherCode, failure, pattern] of [
                [200, 200, false, /PASS health/],
                [200, 401, false, /WARN HTTP=401/],
                [200, 403, false, /WARN HTTP=403/],
                [200, 302, false, /REACHABLE HTTP=302/],
                [302, 200, true, /FAIL health/],
                [403, 200, true, /FAIL health/],
                [200, 407, true, /FAIL HTTP=407/],
                [200, 500, true, /FAIL HTTP=500/],
            ]) {
                health = healthCode;
                other = otherCode;
                const result = await promisify(execFile)(command, [...args, path], {
                    timeout: 30000,
                    env: { ...process.env, HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
                }).then(value => ({ ...value, code: 0 }), error => error);
                assert.equal(result.code, failure ? 1 : 0, `${command} ${health}/${other}\n${result.stdout}\n${result.stderr}`);
                assert.match(result.stdout, pattern);
            }
        }
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    }
});
