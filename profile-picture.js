/**
 * TrackIT — profile picture
 * ---------------------------------------------------------------------------
 * Shared by the OJT, supervisor and coordinator dashboards.
 *
 *  • Paints the signed-in user's picture in any [data-user-avatar] badge and
 *    in the Settings upload card, falling back to their initials.
 *  • Downscales and centre-crops the chosen file in the browser, then saves
 *    the small data URL through PUT /api/dashboard/profile.
 *  • Supports replacing and removing the picture.
 *
 * Other dashboard scripts can listen for `trackit:profile-picture` to repaint
 * their own avatar surfaces after a change.
 */
(function () {
  'use strict';

  if (window.TrackITProfilePicture) return;

  const API_BASE =
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
    window.location.port !== '5000' &&
    window.location.port !== ''
      ? 'http://localhost:5000/api'
      : '/api';

  const MAX_INPUT_BYTES = 8 * 1024 * 1024; // source file, before resizing
  const OUTPUT_SIZE = 360; // square px stored on the server
  const OUTPUT_QUALITY = 0.86;
  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  let busy = false;
  let user = readStoredUser();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function readStoredUser() {
    try {
      return JSON.parse(localStorage.getItem('trackit_user') || 'null');
    } catch (error) {
      return null;
    }
  }

  function authToken() {
    return localStorage.getItem('trackit_token') || window.authToken || '';
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0].charAt(0);
    const second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1) || '';
    return (first + second).toUpperCase();
  }

  /** Inner HTML for an avatar: the picture when there is one, else initials. */
  function avatarInner(person) {
    const source = person || user;
    const picture = source && source.profilePictureDataUrl;
    if (picture) {
      return `<img class="avatar-img" src="${escapeHtml(picture)}" alt="">`;
    }
    return escapeHtml(initials(source && source.fullName));
  }

  function persist(nextUser) {
    if (!nextUser) return;
    user = { ...(user || {}), ...nextUser };
    window.currentUser = user;
    try {
      localStorage.setItem('trackit_user', JSON.stringify(user));
    } catch (error) {
      // A huge picture could exceed the quota; keep the in-memory copy.
      console.warn('[ProfilePicture] Could not cache profile in localStorage:', error);
    }
  }

  function setStatus(card, message, tone) {
    const status = card.querySelector('[data-profile-picture-status]');
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  function paintAvatars() {
    const hasPicture = Boolean(user && user.profilePictureDataUrl);
    document.querySelectorAll('[data-user-avatar]').forEach((node) => {
      node.innerHTML = avatarInner(user);
      node.classList.toggle('has-photo', hasPicture);
    });
  }

  function paintCard(card) {
    if (!card) return;
    const picture = user && user.profilePictureDataUrl;
    const image = card.querySelector('[data-profile-picture-image]');
    const initialsEl = card.querySelector('[data-profile-picture-initials]');
    const remove = card.querySelector('[data-profile-picture-remove]');

    if (image) {
      if (picture) {
        image.src = picture;
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }
    if (initialsEl) {
      initialsEl.textContent = initials(user && user.fullName);
      initialsEl.hidden = Boolean(picture);
    }
    if (remove) remove.hidden = !picture;
    card.classList.toggle('has-photo', Boolean(picture));
  }

  function paint() {
    paintAvatars();
    document.querySelectorAll('[data-profile-picture-card]').forEach(paintCard);
  }

  function announce() {
    window.dispatchEvent(
      new CustomEvent('trackit:profile-picture', { detail: { user } })
    );
  }

  // ── Image preparation ─────────────────────────────────────────────────────

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The image could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That file is not a readable image.'));
      image.src = source;
    });
  }

  /** Centre-crops to a square and shrinks to OUTPUT_SIZE so uploads stay small. */
  function preparePicture(image) {
    const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!side) throw new Error('That image is empty.');

    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not process that image.');

    const sx = ((image.naturalWidth || image.width) - side) / 2;
    const sy = ((image.naturalHeight || image.height) - side) / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Flatten transparency onto white so JPEG fallbacks never look black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.drawImage(image, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    let dataUrl = canvas.toDataURL('image/webp', OUTPUT_QUALITY);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', OUTPUT_QUALITY);
    }
    return dataUrl;
  }

  async function savePicture(dataUrl) {
    const token = authToken();
    if (!token) throw new Error('Your session expired. Please sign in again.');

    const response = await fetch(`${API_BASE}/dashboard/profile`, {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ profilePictureDataUrl: dataUrl }),
    });

    let result = null;
    try {
      result = await response.json();
    } catch (error) {
      result = null;
    }

    if (!response.ok || !result || !result.success) {
      throw new Error((result && result.message) || 'Could not save your picture.');
    }
    persist(result.data || { profilePictureDataUrl: dataUrl });
  }

  // ── Card interactions ─────────────────────────────────────────────────────

  function setBusy(card, value) {
    busy = value;
    card.classList.toggle('is-busy', value);
    card.querySelectorAll('[data-profile-picture-preview], [data-profile-picture-upload], [data-profile-picture-remove]')
      .forEach((button) => {
        button.disabled = value;
      });
  }

  async function handleFile(card, file) {
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setStatus(card, 'Please choose a PNG, JPG or WebP image.', 'error');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setStatus(card, 'That image is over 8 MB. Please choose a smaller one.', 'error');
      return;
    }

    setBusy(card, true);
    setStatus(card, 'Uploading your picture…', 'muted');

    try {
      const source = await readFile(file);
      const image = await loadImage(source);
      const dataUrl = preparePicture(image);

      if (dataUrl.length > 900_000) {
        throw new Error('That image is still too large after resizing. Please try another.');
      }

      await savePicture(dataUrl);
      paint();
      setStatus(card, 'Profile picture updated.', 'success');
      window.setTimeout(() => {
        if (!busy) setStatus(card, '', '');
      }, 3000);
      announce();
    } catch (error) {
      setStatus(card, error.message || 'Could not upload that picture.', 'error');
    } finally {
      setBusy(card, false);
    }
  }

  async function removePicture(card) {
    if (busy) return;
    setBusy(card, true);
    setStatus(card, 'Removing your picture…', 'muted');

    try {
      await savePicture(null);
      paint();
      setStatus(card, 'Profile picture removed.', 'success');
      window.setTimeout(() => {
        if (!busy) setStatus(card, '', '');
      }, 3000);
      announce();
    } catch (error) {
      setStatus(card, error.message || 'Could not remove that picture.', 'error');
    } finally {
      setBusy(card, false);
    }
  }

  function setupCard(card) {
    const input = card.querySelector('[data-profile-picture-input]');
    const preview = card.querySelector('[data-profile-picture-preview]');
    const upload = card.querySelector('[data-profile-picture-upload]');
    const remove = card.querySelector('[data-profile-picture-remove]');

    const openPicker = () => {
      if (busy || !input) return;
      input.click();
    };

    if (preview) preview.addEventListener('click', openPicker);
    if (upload) upload.addEventListener('click', openPicker);
    if (input) {
      input.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        handleFile(card, file).finally(() => {
          // Allow choosing the same file again after a failed attempt.
          event.target.value = '';
        });
      });
    }
    if (remove) remove.addEventListener('click', () => removePicture(card));
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  function setup() {
    user = user || readStoredUser();
    paint();
    document.querySelectorAll('[data-profile-picture-card]').forEach(setupCard);

    window.addEventListener('storage', (event) => {
      if (event.key !== 'trackit_user' || !event.newValue) return;
      user = readStoredUser();
      paint();
    });
  }

  /** Pull the authoritative profile once per page so the picture also shows
   *  for sessions that signed in before the picture was added. */
  async function refreshFromServer() {
    const token = authToken();
    if (!token) return;

    try {
      const response = await fetch(`${API_BASE}/dashboard/profile`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!result || !result.success || !result.data) return;
      persist(result.data);
      paint();
    } catch (error) {
      // Offline or backend restarting: the cached copy is good enough.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }

  window.TrackITProfilePicture = {
    avatarInner,
    initials,
    refresh: () => {
      user = readStoredUser();
      paint();
    },
    getUser: () => user,
  };

  window.addEventListener('load', () => {
    refreshFromServer();
  });
})();
