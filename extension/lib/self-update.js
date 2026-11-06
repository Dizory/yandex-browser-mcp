// The Windows updater swaps the entire unpacked directory before a new marker is visible.
export async function reloadUpdatedExtension(runtime, isIdle, read = fetch) {
  const current = runtime.getManifest().version_name;
  const response = await read(runtime.getURL('manifest.json'), { cache: 'no-store' });
  if (!response.ok) return;
  const next = (await response.json()).version_name;
  if (typeof next === 'string' && /^auto-[1-9]\d*$/.test(next) && next !== current && isIdle()) {
    runtime.reload();
  }
}
