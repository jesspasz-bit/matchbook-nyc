import { supabase } from './supabase.js';
import './style.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'

function loadGooglePlaces() {
  return new Promise(resolve => {
    if (window.google) { resolve(); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_KEY}&libraries=places`;
    script.onload = resolve;
    document.head.appendChild(script);
  });
}

const app = document.getElementById('app');
let currentUser = null;
let currentProfile = null;
let currentTab = 'map';
let map, clusterLayer;
let pendingPhoto = null;
let pendingLatLng = null;
let pendingSpotId = null;

const palette = ['#7F77DD','#1D9E75','#D85A30','#D4537E','#378ADD','#BA7517','#E24B4A','#5F5E5A'];
function avatarColor(handle) {
  let h = 0; for (let i = 0; i < handle.length; i++) h = (h*31 + handle.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function escape(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function timeAgo(ts) {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}
function avatar(handle, sm) {
  const initial = handle.charAt(0).toUpperCase();
  const cls = sm ? 'avatar avatar-sm' : 'avatar';
  return `<div class="${cls}" style="background:${avatarColor(handle)};">${initial}</div>`;
}

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { renderLogin(); return; }
  currentUser = session.user;
  await ensureProfile();
  renderApp();
  renderTab();
}

async function ensureProfile() {
  const { data } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  if (data) { currentProfile = data; return; }
  const handle = prompt("Pick a handle (your username, no @ needed):") || ('user_' + Math.random().toString(36).slice(2,6));
  const { data: created } = await supabase.from('profiles').insert({ id: currentUser.id, handle: handle.toLowerCase().replace(/[^a-z0-9_]/g,'') }).select().single();
  currentProfile = created;
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1 style="font-size:24px;margin-bottom:8px;">Matchbook NYC</h1>
        <p class="muted" style="margin-bottom:24px;">Photo-verified map of NYC matchbook spots. Friends only.</p>
        <input type="email" id="login-email" placeholder="your@email.com" />
        <button class="btn" id="login-btn" style="width:100%;">Send me a magic link</button>
        <p class="muted" style="margin-top:12px;font-size:12px;">We'll email you a one-tap sign in link.</p>
      </div>
    </div>`;
  document.getElementById('login-btn').onclick = async () => {
    const email = document.getElementById('login-email').value.trim();
    if (!email) return;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (error) { alert(error.message); return; }
    document.querySelector('.login-card').innerHTML = `
      <h2>Check your email</h2>
      <p class="muted">We sent a sign-in link to <strong>${escape(email)}</strong>.</p>
      <p class="muted" style="font-size:12px;margin-top:16px;">It might be in spam. Click the link from the same browser.</p>`;
  };
}

function renderApp() {
  app.innerHTML = `
    <div class="app">
      <div class="header">
        <h1 id="header-title">Map</h1>
        <button class="btn-ghost" id="signout-btn">Sign out</button>
      </div>
      <div id="content"></div>
      <div class="tabbar">
        <button class="tabbar-item active" data-tab="map">📍<span>Map</span></button>
        <button class="tabbar-item" data-tab="feed">📷<span>Feed</span></button>
        <button class="tabbar-item" data-tab="add">➕<span>Add</span></button>
        <button class="tabbar-item" data-tab="people">👥<span>People</span></button>
        <button class="tabbar-item" data-tab="you">⭐<span>You</span></button>
      </div>
    </div>`;
  document.querySelectorAll('.tabbar-item').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      if (tab === 'add') { openAddModal(); return; }
      currentTab = tab;
      document.querySelectorAll('.tabbar-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      renderTab();
    };
  });
  document.getElementById('signout-btn').onclick = async () => { await supabase.auth.signOut(); location.reload(); };
}

async function renderTab() {
  const titles = { map: 'Map', feed: 'Feed', people: 'People', you: 'You' };
  document.getElementById('header-title').textContent = titles[currentTab];
  if (currentTab === 'map') renderMap();
  else if (currentTab === 'feed') renderFeed();
  else if (currentTab === 'people') renderPeople();
  else renderYou();
}

async function renderMap() {
  document.getElementById('content').innerHTML = `
    <div class="map-container">
      <div id="map"></div>
      <button class="fab" id="map-fab">+</button>
    </div>`;
  document.getElementById('map-fab').onclick = openAddModal;
  if (map) { map.remove(); }
  map = L.map('map').setView([40.73, -73.99], 12);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(map);
  clusterLayer = L.markerClusterGroup({ maxClusterRadius: 50, showCoverageOnHover: false });
  map.addLayer(clusterLayer);
  const { data: spots } = await supabase.from('spots').select('*');
  (spots || []).forEach(spot => {
    const days = (Date.now() - new Date(spot.last_photo_at)) / 86400000;
    const status = spot.gone_count >= 2 ? 'gone' : days <= 30 ? 'fresh' : 'stale';
    const color = status === 'fresh' ? '#1D9E75' : status === 'stale' ? '#EF9F27' : '#E24B4A';
    const icon = L.divIcon({
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.2);"></div>`,
      iconSize: [18,18], iconAnchor: [9,9], className: ''
    });
    const m = L.marker([spot.lat, spot.lng], { icon });
    const html = `<div class="popup-content">
      <div style="font-weight:600;font-size:14px;">${escape(spot.name)}</div>
      <div class="muted" style="font-size:12px;">${escape(spot.address)}</div>
      ${spot.photo_url ? `<img src="${spot.photo_url}" alt="" />` : ''}
      <div style="font-size:12px;">${escape(spot.notes || '')}</div>
      <div class="muted" style="margin-top:6px;font-size:11px;">${Math.round(days)}d ago</div>
      <button class="btn" style="width:100%;margin-top:8px;font-size:12px;padding:6px;" onclick="window.openRefresh('${spot.id}')">I got one too (+10)</button>
    </div>`;
    m.bindPopup(html);
    clusterLayer.addLayer(m);
  });
}

window.openRefresh = function(spotId) { pendingSpotId = spotId; openAddModal(); };

async function renderFeed() {
  const { data: follows } = await supabase.from('follows').select('following_id').eq('follower_id', currentUser.id);
  const followingIds = (follows || []).map(f => f.following_id);
  const ids = [...followingIds, currentUser.id];
  const { data: finds } = await supabase.from('finds').select('*, profiles!finds_user_id_fkey(handle), spots(name, address)').in('user_id', ids).order('created_at', { ascending: false }).limit(50);
  if (!finds || finds.length === 0) {
    document.getElementById('content').innerHTML = `<div style="padding:40px;text-align:center;">
      <p class="muted">Your feed is empty.</p>
      <p class="muted" style="font-size:13px;">Follow some collectors in the People tab to see their finds.</p>
    </div>`;
    return;
  }
  const findIds = finds.map(f => f.id);
  const { data: allLikes } = await supabase.from('likes').select('*').in('find_id', findIds);
  const { data: allComments } = await supabase.from('comments').select('*, profiles(handle)').in('find_id', findIds).order('created_at', { ascending: true });
  document.getElementById('content').innerHTML = finds.map(f => {
    const handle = f.profiles?.handle || 'unknown';
    const spotName = f.spots?.name || 'Unknown';
    const myLike = allLikes?.find(l => l.find_id === f.id && l.user_id === currentUser.id);
    const likeCount = (allLikes || []).filter(l => l.find_id === f.id).length;
    const findComments = (allComments || []).filter(c => c.find_id === f.id);
    const commentsHtml = findComments.map(c => `
      <div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;font-size:13px;">
        ${avatar(c.profiles?.handle || '?', true)}
        <div><strong>@${escape(c.profiles?.handle || '?')}</strong> ${escape(c.text)}<div class="muted" style="font-size:11px;">${timeAgo(c.created_at)}</div></div>
      </div>`).join('');
    return `<div class="feed-card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        ${avatar(handle)}
        <div><div><strong>@${escape(handle)}</strong> at <strong>${escape(spotName)}</strong></div><div class="muted" style="font-size:12px;">${timeAgo(f.created_at)}</div></div>
      </div>
      ${f.photo_url ? `<img src="${f.photo_url}" class="feed-photo" alt="" />` : ''}
      ${f.caption ? `<div style="font-size:14px;margin-bottom:6px;">${escape(f.caption)}</div>` : ''}
      <div style="display:flex;gap:4px;">
        <button class="like-btn ${myLike ? 'liked' : ''}" onclick="window.toggleLike('${f.id}')">${myLike ? '♥' : '♡'} ${likeCount || ''}</button>
      </div>
      ${commentsHtml ? `<div style="margin-top:6px;">${commentsHtml}</div>` : ''}
      <input type="text" class="comment-input" placeholder="Add a comment..." onkeydown="if(event.key==='Enter')window.addComment('${f.id}', this)" />
    </div>`;
  }).join('');
}

window.toggleLike = async function(findId) {
  const { data: existing } = await supabase.from('likes').select('*').eq('find_id', findId).eq('user_id', currentUser.id).maybeSingle();
  if (existing) { await supabase.from('likes').delete().eq('find_id', findId).eq('user_id', currentUser.id); }
  else { await supabase.from('likes').insert({ find_id: findId, user_id: currentUser.id }); }
  renderTab();
};

window.addComment = async function(findId, input) {
  const text = input.value.trim();
  if (!text) return;
  await supabase.from('comments').insert({ find_id: findId, user_id: currentUser.id, text });
  input.value = '';
  renderTab();
};

async function renderPeople() {
  const { data: profiles } = await supabase.from('profiles').select('*').neq('id', currentUser.id).order('points', { ascending: false });
  const { data: myFollows } = await supabase.from('follows').select('following_id').eq('follower_id', currentUser.id);
  const followingSet = new Set((myFollows || []).map(f => f.following_id));
  document.getElementById('content').innerHTML = (profiles || []).map(p => {
    const isFollowing = followingSet.has(p.id);
    return `<div class="row">
      ${avatar(p.handle)}
      <div style="flex:1;"><strong>@${escape(p.handle)}</strong><div class="muted">${escape(p.bio || '')} · ${p.points || 0} pts</div></div>
      <button class="btn-ghost ${isFollowing ? 'active' : ''}" onclick="window.toggleFollow('${p.id}', ${isFollowing})">${isFollowing ? 'Following' : 'Follow'}</button>
    </div>`;
  }).join('') || '<div style="padding:40px;text-align:center;" class="muted">No other collectors yet.</div>';
}

window.toggleFollow = async function(otherId, isFollowing) {
  if (isFollowing) { await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', otherId); }
  else { await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: otherId }); }
  renderTab();
};

async function renderYou() {
  const { data: myFinds } = await supabase.from('finds').select('*, spots(name)').eq('user_id', currentUser.id).order('created_at', { ascending: false });
  document.getElementById('content').innerHTML = `
    <div style="padding:24px 16px;text-align:center;border-bottom:1px solid var(--border);">
      ${avatar(currentProfile.handle).replace('avatar"', 'avatar" style="width:64px;height:64px;font-size:24px;margin:0 auto 12px;"')}
      <h2 style="margin:0;">@${escape(currentProfile.handle)}</h2>
      <p class="muted">${currentProfile.points || 0} points · ${(myFinds || []).length} finds</p>
    </div>
    <div>${(myFinds || []).map(f => `
      <div class="row">
        <div style="flex:1;"><strong>${escape(f.spots?.name || 'Unknown')}</strong><div class="muted">${timeAgo(f.created_at)}</div></div>
      </div>`).join('') || '<div style="padding:40px;text-align:center;" class="muted">No finds yet. Hit + to log your first.</div>'}</div>`;
}

function openAddModal() {
  const existingModal = document.querySelector('.modal');
  if (existingModal) existingModal.remove();
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="margin:0;font-size:18px;">Log a find</h2>
        <button class="btn-ghost" onclick="document.querySelector('.modal').remove()">×</button>
      </div>
      <div class="photo-drop" id="photo-drop">
        <div id="photo-placeholder">📸 Tap to take or upload a photo<div class="muted" style="font-size:12px;margin-top:4px;">Required</div></div>
        <img id="photo-preview" class="photo-preview" style="display:none;" alt="" />
      </div>
      <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none;" />
      <input type="text" id="spot-name" placeholder="Place name (e.g. Bemelmans Bar)" autocomplete="off" />
      <input type="hidden" id="spot-address" />
      <input type="hidden" id="spot-lat" />
      <input type="hidden" id="spot-lng" />
      <textarea id="spot-notes" rows="2" placeholder="Caption (optional)"></textarea>
      <button class="btn" id="submit-find" style="width:100%;" disabled>Add a photo to submit</button>
    </div>`;

  document.body.appendChild(modal);

  loadGooglePlaces().then(() => {
    const input = document.getElementById('spot-name');
    const autocomplete = new window.google.maps.places.Autocomplete(input, {
      types: ['establishment'],
      componentRestrictions: { country: 'us' }
    });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry) return;
      document.getElementById('spot-address').value = place.formatted_address;
      document.getElementById('spot-lat').value = place.geometry.location.lat();
      document.getElementById('spot-lng').value = place.geometry.location.lng();
      document.getElementById('spot-name').value = place.name;
    });
  });

  document.getElementById('photo-drop').onclick = () => document.getElementById('photo-input').click();
  document.getElementById('photo-input').onchange = handlePhotoSelect;
  document.getElementById('submit-find').onclick = submitFind;

  if (pendingSpotId) {
    supabase.from('spots').select('*').eq('id', pendingSpotId).single().then(({ data }) => {
      if (data) {
        document.getElementById('spot-name').value = data.name;
        document.getElementById('spot-address').value = data.address;
        document.getElementById('spot-lat').value = data.lat;
        document.getElementById('spot-lng').value = data.lng;
      }
    });
  }
}

function handlePhotoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const max = 1200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        pendingPhoto = blob;
        const preview = document.getElementById('photo-preview');
        preview.src = URL.createObjectURL(blob);
        preview.style.display = 'block';
        document.getElementById('photo-placeholder').style.display = 'none';
        const submitBtn = document.getElementById('submit-find');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit (+10 pts)';
      }, 'image/jpeg', 0.85);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

async function submitFind() {
  const submitBtn = document.getElementById('submit-find');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';
  const name = document.getElementById('spot-name').value.trim();
  const address = document.getElementById('spot-address').value.trim();
  const lat = parseFloat(document.getElementById('spot-lat').value);
  const lng = parseFloat(document.getElementById('spot-lng').value);
  const notes = document.getElementById('spot-notes').value.trim();
  if (!name || !address || isNaN(lat) || isNaN(lng) || !pendingPhoto) {
    alert('Please fill in all fields and add a photo.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit (+10 pts)';
    return;
  }
  const filename = `${currentUser.id}/${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('matchbook-photos').upload(filename, pendingPhoto);
  if (uploadError) { alert('Photo upload failed: ' + uploadError.message); submitBtn.disabled = false; return; }
  const { data: { publicUrl } } = supabase.storage.from('matchbook-photos').getPublicUrl(filename);
  let spotId = pendingSpotId;
  if (spotId) {
    await supabase.from('spots').update({ photo_url: publicUrl, last_photo_at: new Date().toISOString(), gone_count: 0 }).eq('id', spotId);
  } else {
    const { data: newSpot } = await supabase.from('spots').insert({ name, address, lat, lng, notes, reported_by: currentUser.id, photo_url: publicUrl }).select().single();
    spotId = newSpot.id;
  }
  await supabase.from('finds').insert({ spot_id: spotId, user_id: currentUser.id, photo_url: publicUrl, caption: notes });
  await supabase.from('profiles').update({ points: (currentProfile.points || 0) + 10 }).eq('id', currentUser.id);
  currentProfile.points = (currentProfile.points || 0) + 10;
  pendingPhoto = null;
  pendingSpotId = null;
  document.querySelector('.modal').remove();
  renderTab();
}

init();