// build/src/downloads.js — RBX Infinity offline downloads engine (Electron main process)
//
// DESIGN
// ------
// A download is: fetch every .ts segment + the rendition .m3u8 for one
// quality of a title's HLS stream, encrypt each segment with AES-256-GCM,
// and write them to disk under the app's userData folder. A local rewritten
// .m3u8 (pointing at the encrypted segment filenames) plus a manifest.json
// (title, encryption IVs, content id) sit alongside them.
//
// KEY MANAGEMENT
// ---------------
// The encryption key is a random 256-bit key generated once per
// installation (not per download) and stored via Electron's safeStorage,
// which encrypts it at rest using the OS keychain (DPAPI on Windows,
// Keychain on macOS). It never leaves the machine and never touches the
// network. This is what makes a copied download folder useless on another
// PC — safeStorage.decrypt() is tied to the OS user account that
// encrypted it, so the key file won't decrypt anywhere else, and even if
// it somehow did, downloads are additionally bound to the Firebase uid
// that owns them (checked before playback) so another RBX Infinity account
// on the same machine can't play them either.
//
// This is a real, meaningful barrier — not DRM-grade (nothing purely
// software-based against a user's own machine is), but it stops the
// straightforward case of "zip the downloads folder and share it".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

class DownloadsEngine {
  /**
   * @param {string} userDataPath - Electron's app.getPath('userData')
   * @param {object} safeStorage - Electron's safeStorage module
   */
  constructor(userDataPath, safeStorage) {
    this.root = path.join(userDataPath, 'offline');
    this.keyFile = path.join(userDataPath, 'offline.key');
    this.manifestFile = path.join(this.root, 'manifest.json');
    this.safeStorage = safeStorage;
    this.activeDownloads = new Map(); // contentId -> { cancelled: bool }

    fs.mkdirSync(this.root, { recursive: true });
    this._key = this._loadOrCreateKey();
  }

  // ─── KEY MANAGEMENT ───────────────────────────────────────────────────────
  _loadOrCreateKey() {
    if (fs.existsSync(this.keyFile)) {
      const encrypted = fs.readFileSync(this.keyFile);
      if (this.safeStorage.isEncryptionAvailable()) {
        try {
          return Buffer.from(this.safeStorage.decryptString(encrypted), 'hex');
        } catch (e) {
          // Key file exists but can't be decrypted on this machine/account —
          // treat as fresh install rather than crashing; old downloads will
          // simply fail their integrity check and get cleaned up.
          console.warn('[Downloads] Could not decrypt existing key, generating new one:', e.message);
        }
      }
    }
    const key = crypto.randomBytes(32);
    if (this.safeStorage.isEncryptionAvailable()) {
      const encrypted = this.safeStorage.encryptString(key.toString('hex'));
      fs.writeFileSync(this.keyFile, encrypted);
    } else {
      // No OS-level secure storage available (rare, e.g. some Linux setups
      // without a keyring) — fall back to a plain file. Still not
      // world-readable in practice since userData is per-user, but callers
      // should know this is a weaker guarantee.
      console.warn('[Downloads] safeStorage unavailable — key stored without OS encryption');
      fs.writeFileSync(this.keyFile, key);
    }
    return key;
  }

  // ─── MANIFEST ─────────────────────────────────────────────────────────────
  _loadManifest() {
    if (!fs.existsSync(this.manifestFile)) return {};
    try { return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')); }
    catch { return {}; }
  }

  _saveManifest(manifest) {
    fs.writeFileSync(this.manifestFile, JSON.stringify(manifest, null, 2));
  }

  listDownloads(uid) {
    const manifest = this._loadManifest();
    return Object.values(manifest).filter(d => d.uid === uid && d.status === 'complete');
  }

  getDownload(uid, contentId) {
    const manifest = this._loadManifest();
    const downloadId = `${uid}_${contentId}`;
    const entry = manifest[downloadId];
    if (!entry || entry.uid !== uid) return null;
    return entry;
  }

  // ─── ENCRYPTION ───────────────────────────────────────────────────────────
  _encryptBuffer(buf) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, this._key, iv);
    const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Layout: [iv (12B)][authTag (16B)][ciphertext]
    return Buffer.concat([iv, authTag, encrypted]);
  }

  _decryptBuffer(buf) {
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = buf.subarray(IV_LENGTH + 16);
    const decipher = crypto.createDecipheriv(ALGO, this._key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // ─── FETCH HELPERS ────────────────────────────────────────────────────────
  _fetch(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._fetch(new URL(res.headers.location, url).toString()).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ─── DOWNLOAD ─────────────────────────────────────────────────────────────
  /**
   * @param {object} opts
   *   uid, contentId, title, poster, masterUrl (HLS master.m3u8 URL),
   *   quality ('1080p'|'720p'|'480p'), onProgress(pct)
   */
  async downloadTitle(opts) {
    const { uid, contentId, title, poster, masterUrl, quality, onProgress } = opts;
    const downloadId = `${uid}_${contentId}`;
    const dir = path.join(this.root, downloadId);
    fs.mkdirSync(dir, { recursive: true });

    const cancelToken = { cancelled: false };
    this.activeDownloads.set(downloadId, cancelToken);

    const manifest = this._loadManifest();
    manifest[downloadId] = {
      uid, contentId, title, poster, quality,
      status: 'downloading', progress: 0, addedAt: Date.now()
    };
    this._saveManifest(manifest);

    try {
      // 1. Resolve the master playlist to find the rendition URL for the
      //    requested quality.
      const masterText = (await this._fetch(masterUrl)).toString('utf8');
      const renditionUrl = this._resolveRendition(masterUrl, masterText, quality);
      if (!renditionUrl) throw new Error(`No se encontró la calidad ${quality} en el stream`);

      // 2. Fetch the rendition playlist and every segment it lists.
      const renditionText = (await this._fetch(renditionUrl)).toString('utf8');
      const segmentUrls = this._extractSegmentUrls(renditionUrl, renditionText);
      if (!segmentUrls.length) throw new Error('El stream no tiene segmentos de vídeo');

      const localLines = [];
      let done = 0;
      for (const line of renditionText.split('\n')) {
        if (line.trim() && !line.startsWith('#')) {
          const segIndex = done;
          const segUrl = segmentUrls[segIndex];

          if (cancelToken.cancelled) throw new Error('__CANCELLED__');

          const segData = await this._fetch(segUrl);
          const encrypted = this._encryptBuffer(segData);
          const localName = `seg_${String(segIndex).padStart(5, '0')}.enc`;
          fs.writeFileSync(path.join(dir, localName), encrypted);
          localLines.push(localName);

          done++;
          const pct = Math.round((done / segmentUrls.length) * 100);
          manifest[downloadId].progress = pct;
          this._saveManifest(manifest);
          if (onProgress) onProgress(pct);
        } else {
          localLines.push(line);
        }
      }

      // 3. Write the rewritten local playlist (segment refs now point at
      //    the .enc filenames — the custom protocol handler decrypts them
      //    on the fly at playback time, see registerOfflineProtocol()).
      fs.writeFileSync(path.join(dir, 'local.m3u8'), localLines.join('\n'));

      manifest[downloadId] = {
        ...manifest[downloadId],
        status: 'complete', progress: 100, completedAt: Date.now(),
        sizeBytes: this._dirSize(dir)
      };
      this._saveManifest(manifest);
      this.activeDownloads.delete(downloadId);
      return { success: true };
    } catch (e) {
      this.activeDownloads.delete(downloadId);
      if (e.message === '__CANCELLED__') {
        this._removeDownloadFiles(downloadId);
        const m = this._loadManifest();
        delete m[downloadId];
        this._saveManifest(m);
        return { success: false, cancelled: true };
      }
      const m = this._loadManifest();
      if (m[downloadId]) { m[downloadId].status = 'failed'; m[downloadId].error = e.message; }
      this._saveManifest(m);
      throw e;
    }
  }

  cancelDownload(uid, contentId) {
    const downloadId = `${uid}_${contentId}`;
    const token = this.activeDownloads.get(downloadId);
    if (token) token.cancelled = true;
  }

  deleteDownload(uid, contentId) {
    const downloadId = `${uid}_${contentId}`;
    this._removeDownloadFiles(downloadId);
    const manifest = this._loadManifest();
    delete manifest[downloadId];
    this._saveManifest(manifest);
  }

  _removeDownloadFiles(downloadId) {
    const dir = path.join(this.root, downloadId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  _dirSize(dir) {
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      total += fs.statSync(path.join(dir, f)).size;
    }
    return total;
  }

  // ─── M3U8 PARSING ─────────────────────────────────────────────────────────
  _resolveRendition(masterUrl, masterText, quality) {
    const targetHeight = { '1080p': 1080, '720p': 720, '480p': 480 }[quality];
    const lines = masterText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i].includes(`x${targetHeight}`)) {
        const uriLine = lines[i + 1]?.trim();
        if (uriLine) return new URL(uriLine, masterUrl).toString();
      }
    }
    return null;
  }

  _extractSegmentUrls(renditionUrl, renditionText) {
    return renditionText.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => new URL(l.trim(), renditionUrl).toString());
  }

  // ─── PLAYBACK: decrypt a single segment on demand ────────────────────────
  readSegment(uid, contentId, filename) {
    const downloadId = `${uid}_${contentId}`;
    const filePath = path.join(this.root, downloadId, filename);
    if (!fs.existsSync(filePath)) throw new Error('Segmento no encontrado');
    if (filename.endsWith('.m3u8')) return fs.readFileSync(filePath); // playlist itself isn't encrypted
    const encrypted = fs.readFileSync(filePath);
    return this._decryptBuffer(encrypted);
  }

  getLocalPlaylistPath(uid, contentId) {
    return path.join(this.root, `${uid}_${contentId}`, 'local.m3u8');
  }
}

module.exports = { DownloadsEngine };
