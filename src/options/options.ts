import { callSw } from '../shared/rpc';
import { DEFAULT_SETTINGS, getSettings, type Settings, type SyncStatus } from '../background/sync';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function show() {
  const s = await getSettings();
  ($('sync-enabled') as HTMLInputElement).checked = s.syncEnabled;
  ($('url') as HTMLInputElement).value = s.companionUrl;
  await status();
}
async function status() {
  const st = await callSw<SyncStatus>({ type: 'sync:status' }).catch(() => ({ state: 'off' }) as SyncStatus);
  $('status').textContent =
    st.state === 'ok' ? `Connected — ${st.remoteNotes} notes in ${st.dir}` : st.state === 'error' ? `Error: ${st.error}` : 'Sync is off.';
}
async function save() {
  const settings: Settings = { syncEnabled: ($('sync-enabled') as HTMLInputElement).checked, companionUrl: ($('url') as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.companionUrl };
  await chrome.storage.local.set({ settings });
}
$('save').addEventListener('click', async () => {
  await save();
  await status();
});
$('test').addEventListener('click', async () => {
  await save();
  await callSw({ type: 'sync:now' });
  await status();
});
void show();
