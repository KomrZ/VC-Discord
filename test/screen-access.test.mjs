import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
const project = resolve(import.meta.dirname, '..');
mkdirSync(join(project, '.tmp-tests'), { recursive: true });
const temporary = mkdtempSync(join(project, '.tmp-tests', 'screen-'));
process.env.DVOICE_DATA_DIR = temporary;
const require = createRequire(import.meta.url);
const core = require('./artifact/plugin.cjs');
const guild = '111111111111111111', channel = '222222222222222222';
const owner = '112233445566778899', viewer = '998877665544332211';
after(() => { assert.ok(temporary.startsWith(project + sep)); rmSync(temporary, { recursive: true, force: true }); });

// A local model server records every request body and can answer with an
// empty "length" reply so publicChat retries the same request.
async function modelServer(reply = { content: 'Ответ' }) {
  const requests = [];
  let onRequest;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push(JSON.parse(body));
      if (onRequest) onRequest(requests.length);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content }, finish_reason: reply.finish_reason }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { requests, server, url: `http://127.0.0.1:${server.address().port}/v1`, hook: fn => { onRequest = fn; } };
}
const speaker = userId => ({ userId, guildId: guild, channelId: channel, generation: 1 });
function bridgeHarness(url, extra = {}) {
  const bridge = new core.VoiceBridge();
  bridge.settings = core.normalizeSettings({ llmUseAstra: false, llmUseAstraPersonality: false, llmModel: 'local', llmBaseUrl: url, guildId: guild, channelId: channel, ...extra });
  bridge.transport = { connected: true, present: () => true, participants: () => [{ id: owner }], play: async () => {}, stopPlayback: () => {}, disconnect: () => {} };
  bridge.providers = { transcribe: async () => 'Расскажи анекдот', speak: async () => Buffer.alloc(3840), stop: () => {} };
  bridge.browserScreen = { capture: () => 'data:image/jpeg;base64,AAAA', status: () => ({ prepared: true, ready: true }), stop: () => {} };
  bridge.screenSharing = true;
  return bridge;
}
const imageParts = request => request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');

// enqueue() starts drain() itself, so awaiting the private drain() returns
// immediately while the queued utterance is still being processed.
async function waitUntil(condition, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timeout waiting for ' + label);
    await new Promise(r => setTimeout(r, 10));
  }
}
async function settle(bridge, model, expected = 1) {
  await waitUntil(() => model.requests.length >= expected, 'model request');
  await waitUntil(() => !bridge.processing && bridge.queue.length === 0, 'bridge idle');
}

test('a PC-access account without a screen ID gets no image, and the request carries no image_url', async t => {
  const model = await modelServer(); t.after(() => model.server.close());
  const bridge = bridgeHarness(model.url, { allowedUserIds: [owner] });
  bridge.enqueue(speaker(owner), Buffer.alloc(3840));
  await settle(bridge, model);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(imageParts(model.requests[0]), []);
  assert.deepEqual(bridge.settings.screenUserIds, []);
});

test('an account listed in screenUserIds receives the screen image even without PC access', async t => {
  const model = await modelServer(); t.after(() => model.server.close());
  const bridge = bridgeHarness(model.url, { screenUserIds: [viewer], allowedUserIds: [] });
  bridge.enqueue(speaker(viewer), Buffer.alloc(3840));
  await settle(bridge, model);
  assert.equal(model.requests.length, 1);
  const parts = imageParts(model.requests[0]);
  assert.equal(parts.length, 1);
  assert.match(parts[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(bridge.settings.allowedUserIds, []);
});

test('revoking screenUserIds during the request cancels the retry instead of resending the image', async t => {
  const model = await modelServer({ content: '', finish_reason: 'length' }); t.after(() => model.server.close());
  const bridge = bridgeHarness(model.url, { screenUserIds: [viewer] });
  model.hook(() => { bridge.settings = { ...bridge.settings, screenUserIds: [] }; });
  bridge.enqueue(speaker(viewer), Buffer.alloc(3840));
  await settle(bridge, model);
  // The first (image) request was sent; the retry was refused, so no second request.
  assert.equal(model.requests.length, 1);
  assert.equal(imageParts(model.requests[0]).length, 1);
});

test('publicChat retryAllowed refuses a retry once the screen list no longer covers the speaker', async t => {
  const model = await modelServer({ content: '', finish_reason: 'length' }); t.after(() => model.server.close());
  const s = core.normalizeSettings({ llmUseAstra: false, llmModel: 'local', llmBaseUrl: model.url });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA', detail: 'auto' } }] }];
  await assert.rejects(core.publicChat(s, messages, undefined, () => false), /отменён/);
  assert.equal(model.requests.length, 1);
});

test('loading a profile without screenUserIds copies allowedUserIds, while an explicit empty list stays empty', async () => {
  writeFileSync(join(temporary, 'settings.json'), JSON.stringify({ settings: { allowedUserIds: [owner, viewer] } }));
  const migrated = await new core.SettingsStore().load();
  assert.deepEqual(migrated.screenUserIds, [owner, viewer]);
  assert.notEqual(migrated.screenUserIds, migrated.allowedUserIds);

  writeFileSync(join(temporary, 'settings.json'), JSON.stringify({ settings: { allowedUserIds: [owner], screenUserIds: [] } }));
  assert.deepEqual((await new core.SettingsStore().load()).screenUserIds, []);

  writeFileSync(join(temporary, 'settings.json'), JSON.stringify({ settings: { allowedUserIds: [owner], screenUserIds: [viewer] } }));
  assert.deepEqual((await new core.SettingsStore().load()).screenUserIds, [viewer]);
});

test('a profile with no settings file keeps an empty screen list and screen IDs are validated as Discord IDs', async () => {
  const empty = core.normalizeSettings({});
  assert.deepEqual(empty.screenUserIds, []);
  assert.throws(() => core.validateSettings({ ...empty, screenUserIds: ['not-an-id'] }), /Discord ID/);
  assert.doesNotThrow(() => core.validateSettings({ ...empty, screenUserIds: [owner] }));
});
