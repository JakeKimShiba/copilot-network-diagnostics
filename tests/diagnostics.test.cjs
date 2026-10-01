const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { createServer } = require('node:http');
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
        for (const key of keys) assert.ok(translations[language][key], `${language}: ${key}`);
        a.run(`setLang('${language}')`);
        for (const guide of ['vscode', 'jetbrains', 'vs', 'xcode', 'cli', 'other']) {
            a.run(`currentIdeTab = '${guide}'; renderIdeGuide()`);
            assert.doesNotMatch(a.nodes.get('ide-content').innerHTML, /undefined/);
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
    assert.equal(a.nodes.get('plan-input').hidden, true);
});

test('restricted routing allows either or both organization groups, never a broad wildcard', () => {
    const a = app();
    a.set('opt-routing', true);
    for (const [business, enterprise] of [[true, false], [false, true], [true, true]]) {
        a.set('routing-business', business);
        a.set('routing-enterprise', enterprise);
        const rules = a.json('getFirewallRules(getSelectedPlan(), getOptions())');
        assert.ok(!rules.some(rule => rule.domain === '*.githubcopilot.com/*'));
        assert.equal(rules.find(rule => rule.domain === '*.individual.githubcopilot.com').tag, 'routing-block');
        assert.equal(rules.find(rule => rule.domain === '*.business.githubcopilot.com').tag, business ? 'routing-allow' : 'routing-block');
        assert.equal(rules.find(rule => rule.domain === '*.enterprise.githubcopilot.com').tag, enterprise ? 'routing-allow' : 'routing-block');
        assert.ok(!a.json('getTestableGroups()').flatMap(group => group.endpoints).some(ep => ep.url === 'https://api.githubcopilot.com/_ping'));
        const [allow, block] = a.run('buildFirewallRulesText()').split('\nBLOCK (not allowlist entries)\n');
        assert.doesNotMatch(allow, /\*\.individual\.githubcopilot\.com/);
        assert.match(block, /\*\.individual\.githubcopilot\.com/);
    }
    a.set('routing-business', false);
    a.set('routing-enterprise', false);
    assert.equal(a.run('configurationError(getOptions())'), 'config.routingError');
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
        'download.opensuse.org', '172.18.0.1', 'repo.grails.org']) assert.ok(hosts.includes(host), host);
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

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
test('PowerShell is installed in CI', { skip: !process.env.CI }, () => assert.ok(hasPowerShell));
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
            const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath], {
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
    const result = spawnSync('pwsh', ['-NoProfile', '-Command',
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
        if (hasPowerShell) runners.push(['pwsh', 'generatePowerShellScript()', ['-NoProfile', '-File']]);
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
