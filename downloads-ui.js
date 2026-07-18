// js/downloads-ui.js — RBX Infinity offline downloads (desktop only)
//
// Everything here is a no-op when window.rbxDesktop isn't present (i.e.
// running in a normal browser tab) — downloads are an Electron-only
// feature since they rely on the main process's encrypted-storage engine
// in build/src/downloads.js. isDesktop() is the single gate the rest of
// the app should check before showing any download UI.

let _currentUser = null;

export function initDownloads(user) {
  _currentUser = user;
  if (!isDesktop()) return;
  window.rbxDesktop.downloads.onProgress(({ contentId, pct }) => {
    _updateProgressUI(contentId, pct);
  });
  window.rbxDesktop.downloads.onComplete(({ contentId }) => {
    _updateProgressUI(contentId, 100, true);
    window.showToast?.('Descarga completada ✓', 'success');
  });
  window.rbxDesktop.downloads.onError(({ contentId, error }) => {
    _updateProgressUI(contentId, 0, false, true);
    window.showToast?.('Error al descargar: ' + error, 'error');
  });
}

export function isDesktop() {
  return typeof window !== 'undefined' && !!window.rbxDesktop?.isDesktop;
}

// ─── START / CANCEL / DELETE ────────────────────────────────────────────────
export async function startDownload(item, quality = '720p') {
  if (!isDesktop() || !_currentUser) return;
  if (!item.video) { window.showToast?.('Este contenido no tiene vídeo para descargar', 'error'); return; }

  window.showToast?.(`Descargando "${item.titulo}"…`, 'info');
  try {
    await window.rbxDesktop.downloads.start({
      uid: _currentUser.uid,
      contentId: item.id,
      title: item.titulo,
      poster: item.poster || item.banner || null,
      masterUrl: item.video,
      quality
    });
  } catch (e) {
    window.showToast?.('No se pudo iniciar la descarga: ' + e.message, 'error');
  }
}

export async function cancelDownload(contentId) {
  if (!isDesktop() || !_currentUser) return;
  await window.rbxDesktop.downloads.cancel(_currentUser.uid, contentId);
}

export async function deleteDownload(contentId) {
  if (!isDesktop() || !_currentUser) return;
  await window.rbxDesktop.downloads.delete(_currentUser.uid, contentId);
}

export async function listDownloads() {
  if (!isDesktop() || !_currentUser) return [];
  return await window.rbxDesktop.downloads.list(_currentUser.uid);
}

export async function getDownloadStatus(contentId) {
  if (!isDesktop() || !_currentUser) return null;
  return await window.rbxDesktop.downloads.get(_currentUser.uid, contentId);
}

// Returns a playback src for the offline copy, or null if not downloaded —
// callers (playContent/playEpisode) use this to decide whether to hand the
// player the offline rbx-offline:// URL or the normal streaming URL.
export async function getOfflinePlaybackUrl(contentId) {
  if (!isDesktop() || !_currentUser) return null;
  return await window.rbxDesktop.downloads.getPlaybackUrl(_currentUser.uid, contentId);
}

// ─── UI: download button for the content detail modal ───────────────────────
export function renderDownloadButton(item) {
  if (!isDesktop()) return '';
  return `
    <div id="dlBtnWrap_${item.id}" class="download-btn-wrap">
      <button class="btn-download" id="dlBtn_${item.id}" onclick="openDownloadQualityPicker('${item.id}')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        <span id="dlBtnLabel_${item.id}">Descargar</span>
      </button>
    </div>`;
}

// Called after the modal is in the DOM, to set the button's actual state
// (not downloaded / downloading X% / downloaded ✓) since that requires an
// async IPC round trip the synchronous render above can't do.
export async function refreshDownloadButton(item) {
  if (!isDesktop()) return;
  const status = await getDownloadStatus(item.id);
  _applyButtonState(item.id, status);
}

function _applyButtonState(contentId, status) {
  const btn = document.getElementById(`dlBtn_${contentId}`);
  const label = document.getElementById(`dlBtnLabel_${contentId}`);
  if (!btn || !label) return;

  if (!status) {
    btn.classList.remove('dl-active', 'dl-done');
    label.textContent = 'Descargar';
    btn.onclick = () => window.openDownloadQualityPicker(contentId);
  } else if (status.status === 'downloading') {
    btn.classList.add('dl-active');
    btn.classList.remove('dl-done');
    label.textContent = `Descargando ${status.progress || 0}%`;
    btn.onclick = () => window.cancelDownloadUI(contentId);
  } else if (status.status === 'complete') {
    btn.classList.add('dl-done');
    btn.classList.remove('dl-active');
    label.textContent = 'Descargada ✓';
    btn.onclick = () => window.confirmDeleteDownloadUI(contentId);
  } else if (status.status === 'failed') {
    btn.classList.remove('dl-active', 'dl-done');
    label.textContent = 'Reintentar descarga';
    btn.onclick = () => window.openDownloadQualityPicker(contentId);
  }
}

function _updateProgressUI(contentId, pct, done = false, failed = false) {
  const label = document.getElementById(`dlBtnLabel_${contentId}`);
  const btn = document.getElementById(`dlBtn_${contentId}`);
  if (!label || !btn) return;
  if (failed) { _applyButtonState(contentId, { status: 'failed' }); return; }
  if (done) { _applyButtonState(contentId, { status: 'complete' }); return; }
  btn.classList.add('dl-active');
  label.textContent = `Descargando ${pct}%`;
}

// ─── QUALITY PICKER ───────────────────────────────────────────────────────────
window.openDownloadQualityPicker = (contentId) => {
  const existing = document.getElementById('dlQualityModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dlQualityModal';
  modal.className = 'dl-quality-modal-wrap';
  modal.innerHTML = `
    <div class="dl-quality-backdrop" onclick="document.getElementById('dlQualityModal').remove()"></div>
    <div class="dl-quality-card">
      <h3>Elige la calidad</h3>
      <p class="dl-quality-note">Las calidades más altas ocupan más espacio en disco.</p>
      <button class="dl-quality-opt" onclick="confirmStartDownload('${contentId}','1080p')">
        <strong>1080p</strong><span>Full HD · ~2.5 GB/hora</span>
      </button>
      <button class="dl-quality-opt" onclick="confirmStartDownload('${contentId}','720p')">
        <strong>720p</strong><span>HD · ~1.2 GB/hora</span>
      </button>
      <button class="dl-quality-opt" onclick="confirmStartDownload('${contentId}','480p')">
        <strong>480p</strong><span>Ahorra espacio · ~600 MB/hora</span>
      </button>
      <button class="btn-secondary" style="width:100%;margin-top:10px" onclick="document.getElementById('dlQualityModal').remove()">Cancelar</button>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('dl-visible'));
};

window.confirmStartDownload = async (contentId, quality) => {
  document.getElementById('dlQualityModal')?.remove();
  const item = window.getContentById ? window.getContentById(contentId) : null;
  if (!item) { window.showToast?.('No se pudo iniciar la descarga', 'error'); return; }
  await startDownload(item, quality);
  await refreshDownloadButton(item);
};

window.cancelDownloadUI = async (contentId) => {
  await cancelDownload(contentId);
  const btn = document.getElementById(`dlBtn_${contentId}`);
  if (btn) _applyButtonState(contentId, null);
  window.showToast?.('Descarga cancelada', 'info');
};

window.confirmDeleteDownloadUI = async (contentId) => {
  if (!confirm('¿Eliminar esta descarga? Tendrás que volver a descargarla para verla offline.')) return;
  await deleteDownload(contentId);
  _applyButtonState(contentId, null);
  window.showToast?.('Descarga eliminada', 'info');
};
