(function () {
  'use strict';

  const HINTS = ['Build', 'Fix', 'Explore', 'Scout'];

  const DEFAULT_COLORS = {
    builder: '#f5b44c',
    planner: '#a882ff',
    lead: '#b8f24b',
    breaker: '#3dd68c',
  };

  const SURFACE_ICONS = {
    floor:
      '<svg class="cb-door-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    hopper:
      '<svg class="cb-door-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    schedule:
      '<svg class="cb-door-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    den:
      '<svg class="cb-door-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  };

  const rootEl = document.getElementById('hub-root');
  const toastEl = document.getElementById('hub-toast');

  const ui = {
    selectedCrewId: null,
    urgentOnly: false,
    dropOpen: false,
    justOpenedDrop: false,
    draftText: '',
    draftHint: 'Build',
    submitting: false,
    refreshing: false,
    connected: true,
    activeSurface: null,
    busyIds: new Set(),
  };

  let hubState = null;
  let toastTimer = null;
  let sseDebounceTimer = null;
  let bootSeen = null;
  let lostLine = false;
  let lastVisRefresh = 0;

  function esc(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, tone = 'info') {
    if (!toastEl || !message) return;
    toastEl.textContent = message;
    toastEl.className = 'hub-toast is-visible';
    if (tone === 'success') toastEl.classList.add('is-success');
    if (tone === 'warn') toastEl.classList.add('is-warn');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 2400);
  }

  function resolveSurfaceUrl(surfaceId, openPath, openKind) {
    const proto = window.location.protocol || 'http:';
    const host = window.location.hostname || '127.0.0.1';
    const isTailscale = host.endsWith('.ts.net');
    const origin = window.location.origin;

    if (openKind === 'link') {
      return isTailscale ? `${proto}//${host}:7950/link/` : `http://${host}:7970/`;
    }

    switch (surfaceId) {
      case 'floor':
        return `${proto}//${host}:7960/`;
      case 'hopper': {
        const cleanPath = openPath
          ? (openPath.startsWith('/') ? openPath : `/${openPath}`)
          : '/';
        return `${origin}${cleanPath}`;
      }
      case 'schedule':
        return `${proto}//${host}:7968/`;
      case 'den':
        return `${proto}//${host}:7950/`;
      default:
        return `${origin}/`;
    }
  }

  function isUrgentItem(item) {
    return Boolean(item && (item.urgent || item.priority === 'urgent'));
  }

  function crewColor(member) {
    if (member && member.color) return member.color;
    const id = member && member.id ? String(member.id).toLowerCase() : '';
    return DEFAULT_COLORS[id] || '#f5a524';
  }

  function shortSurfaceName(surface) {
    if (!surface) return '';
    const map = { floor: 'Floor', hopper: 'Hopper', schedule: 'Schedule', den: 'Den' };
    return map[surface.id] || surface.name || surface.id || '';
  }

  function getAgentCounts(agentId, member, items) {
    const agentItems = items.filter((i) => i.agent === agentId);
    if (agentItems.length === 0) {
      const fallback = Number(member && member.needsCount) || 0;
      return { urgentOpen: fallback, totalOpen: fallback };
    }
    const open = agentItems.filter((i) => !i.done);
    const urgentOpen = open.filter(isUrgentItem).length;
    return { urgentOpen, totalOpen: open.length };
  }

  function sortItems(list) {
    return list.slice().sort((a, b) => {
      if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
      const au = isUrgentItem(a) ? 0 : 1;
      const bu = isUrgentItem(b) ? 0 : 1;
      return au - bu;
    });
  }

  async function apiJson(endpoint, options = {}) {
    const res = await fetch(endpoint, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function renderItemCard(item, crewMap, surfaceMap) {
    const member = crewMap.get(item.agent);
    const surf = surfaceMap.get(item.surface);
    const accent = crewColor(member);
    const urgent = isUrgentItem(item) && !item.done;
    const done = Boolean(item.done);
    const busy = ui.busyIds.has(item.id);
    const surfaceLabel = surf ? shortSurfaceName(surf) : item.surface || 'Open';
    const openText = item.actionLabel ? `${item.actionLabel} ↗` : `Open ${surfaceLabel} ↗`;

    return `
      <article class="cb-item ${urgent ? 'cb-item-urgent' : ''} ${done ? 'cb-item-done' : ''}" style="--cb-accent:${esc(accent)}" data-cb-item-id="${esc(item.id)}">
        <div class="cb-item-top">
          <div class="cb-item-tags">
            ${
              member
                ? `<span class="cb-agent-pill"><span class="cb-agent-dot"></span>${esc(member.name)}</span>`
                : ''
            }
            <span class="cb-surface-tag">${esc(item.surfaceTag || surfaceLabel)}</span>
          </div>
          ${item.ago ? `<span class="cb-item-ago">${esc(item.ago)}</span>` : ''}
        </div>
        <div class="cb-item-title">${esc(item.title)}</div>
        ${item.why ? `<div class="cb-item-why">${esc(item.why)}</div>` : ''}
        <div class="cb-item-actions">
          <button
            type="button"
            class="cb-btn-done ${done ? 'cb-is-undo' : ''}"
            data-cb-action="triage"
            data-cb-id="${esc(item.id)}"
            ${busy ? 'disabled' : ''}
          >
            ${done ? '↺ Undo' : '✓ Mark Done'}
          </button>
          <button
            type="button"
            class="cb-btn-open"
            data-cb-action="open-surface"
            data-cb-surface="${esc(item.surface)}"
            data-cb-open-path="${esc(item.openPath || '')}"
            data-cb-open-kind="${esc(item.openKind || '')}"
          >
            ${esc(openText)}
          </button>
        </div>
      </article>
    `;
  }

  function renderHudOverview(state, items, surfaces, drops, crewMap, surfaceMap) {
    const radarHtml = surfaces
      .slice(0, 4)
      .map((s) => {
        const status = s.status === 'needs' || s.status === 'ready' ? s.status : 'calm';
        const count = Number(s.count) || 0;
        return `
          <button
            type="button"
            class="cb-radar-tile cb-st-${esc(status)}"
            data-cb-action="open-surface"
            data-cb-surface="${esc(s.id)}"
            data-cb-open-path="${esc(s.path || '/')}"
            title="Open ${esc(s.name || s.id)}"
          >
            <div class="cb-radar-top">
              <span class="cb-radar-name">
                <span class="cb-sdot cb-sdot-${esc(status)}"></span>
                <span>${esc(shortSurfaceName(s))}</span>
              </span>
              ${count > 0 ? `<span class="cb-radar-count">${esc(count)}</span>` : ''}
            </div>
            <div class="cb-radar-headline">${esc(s.headline || s.detail || 'Quiet')}</div>
          </button>
        `;
      })
      .join('');

    const visibleItems = sortItems(
      ui.urgentOnly ? items.filter((i) => isUrgentItem(i) && !i.done) : items
    );

    const latestDrop = drops.length > 0 ? drops[0] : null;
    const dropStrip = latestDrop
      ? `
        <div class="cb-drop-ticker" title="${esc(latestDrop.text)}">
          <span class="cb-drop-ticker-tag">${esc(latestDrop.hint || 'Drop')}</span>
          <span class="cb-drop-ticker-text">${esc(latestDrop.text)}</span>
        </div>
      `
      : '';

    let feedHtml = '';
    if (visibleItems.length > 0) {
      feedHtml = `
        <div class="cb-item-list">
          ${visibleItems.map((i) => renderItemCard(i, crewMap, surfaceMap)).join('')}
        </div>
      `;
    } else {
      const hasNonUrgent = ui.urgentOnly && items.some((i) => !i.done);
      feedHtml = `
        <div class="cb-empty-card">
          <div class="cb-empty-title">${ui.urgentOnly ? 'Zero urgent items waiting' : 'All caught up'}</div>
          <div class="cb-empty-sub">${
            hasNonUrgent
              ? 'Everything urgent is cleared. Toggle off the filter to peek at background updates.'
              : 'Tap any crew face below to check their lane or drop a fresh spark.'
          }</div>
          ${
            hasNonUrgent
              ? `<button type="button" class="cb-stage-link" data-cb-action="toggle-urgent">Show all items</button>`
              : ''
          }
        </div>
      `;
    }

    return `
      <section class="cb-radar" aria-label="4-Surface Signal Radar">
        ${radarHtml}
      </section>
      ${dropStrip}
      <section class="cb-hud-stage" aria-label="Live Queue">
        <div class="cb-stage-head">
          <span class="cb-stage-label">${ui.urgentOnly ? 'Needs You Now' : 'Active Radar Feed'}</span>
          <span class="cb-stage-label">${visibleItems.filter((i) => !i.done).length} open</span>
        </div>
        ${feedHtml}
      </section>
    `;
  }

  function renderHudCrewFocus(member, items, crewMap, surfaceMap) {
    const accent = crewColor(member);
    const agentAll = items.filter((i) => i.agent === member.id);
    const filtered = sortItems(
      ui.urgentOnly ? agentAll.filter((i) => isUrgentItem(i) && !i.done) : agentAll
    );
    const hiddenOpen = ui.urgentOnly ? agentAll.filter((i) => !i.done && !isUrgentItem(i)).length : 0;

    let bodyHtml = '';
    if (filtered.length > 0) {
      bodyHtml = `
        <div class="cb-item-list cb-is-focused">
          ${filtered.map((i) => renderItemCard(i, crewMap, surfaceMap)).join('')}
        </div>
      `;
    } else {
      const doorIds = Array.isArray(member.surfaces) && member.surfaces.length > 0 ? member.surfaces : [];
      const doorBtns = doorIds
        .map((sid) => {
          const s = surfaceMap.get(sid);
          const label = s ? shortSurfaceName(s) : sid;
          return `
            <button type="button" class="cb-btn-open" data-cb-action="open-surface" data-cb-surface="${esc(sid)}" data-cb-open-path="${esc((s && s.path) || '/')}">
              Open ${esc(label)} ↗
            </button>
          `;
        })
        .join('');

      bodyHtml = `
        <div class="cb-empty-card">
          <div class="cb-empty-title">${esc(member.name)} has nothing urgent waiting</div>
          <div class="cb-empty-sub">${esc(member.statusText || 'Lane is calm and humming.')}</div>
          <div class="cb-empty-doors">
            ${
              hiddenOpen > 0
                ? `<button type="button" class="cb-btn-done" data-cb-action="toggle-urgent">Show ${hiddenOpen} calm item${hiddenOpen > 1 ? 's' : ''}</button>`
                : ''
            }
            ${doorBtns}
          </div>
        </div>
      `;
    }

    return `
      <section class="cb-hud-stage" aria-label="${esc(member.name)} Focus">
        <div class="cb-focus-bar" style="--cb-accent:${esc(accent)}">
          <div class="cb-focus-who">
            <img
              class="cb-focus-avatar"
              src="${esc(member.faceUrl || '')}"
              alt="${esc(member.name)}"
              onerror="this.style.visibility='hidden'"
            />
            <div class="cb-focus-meta">
              <div class="cb-focus-name">
                <span>${esc(member.name)}</span>
                ${member.role ? `<span class="cb-focus-role">· ${esc(member.role)}</span>` : ''}
              </div>
              <div class="cb-focus-status">${esc(member.statusText || 'Ready')}</div>
            </div>
          </div>
          <button type="button" class="cb-back-btn" data-cb-action="clear-crew">← Radar</button>
        </div>
        ${bodyHtml}
      </section>
    `;
  }

  function renderQuickDropSheet(drops) {
    const hintHtml = HINTS.map((h) => {
      const picked = ui.draftHint === h;
      return `
        <button
          type="button"
          class="cb-hint-chip ${picked ? 'cb-is-picked' : ''}"
          data-cb-action="pick-hint"
          data-cb-hint="${esc(h)}"
        >
          ${esc(h)}
        </button>
      `;
    }).join('');

    const recentHtml =
      drops.length > 0
        ? `
          <div class="cb-recent-drops">
            <div class="cb-recent-head">Recent Drops (${drops.length})</div>
            ${drops
              .slice(0, 3)
              .map(
                (d) => `
                <div class="cb-recent-row">
                  <span class="cb-recent-text">${esc(d.text)}</span>
                  <span class="cb-recent-hint">${esc(d.hint || 'Drop')}</span>
                </div>
              `
              )
              .join('')}
          </div>
        `
        : '';

    const canSend = ui.draftText.trim().length > 0 && !ui.submitting;

    return `
      <div class="cb-sheet-backdrop" data-cb-action="close-drop-backdrop">
        <div class="cb-sheet" role="dialog" aria-modal="true" aria-label="Quick Drop to Hopper">
          <div class="cb-sheet-grab"></div>
          <div class="cb-sheet-head">
            <span class="cb-sheet-title">Drop to Hopper</span>
            <button type="button" class="cb-sheet-close" data-cb-action="close-drop">Close</button>
          </div>
          <textarea
            class="cb-sheet-input"
            data-cb-input="drop-text"
            placeholder="Raw spark, snag, or build idea..."
            rows="3"
          >${esc(ui.draftText)}</textarea>
          <div class="cb-hint-row" role="group" aria-label="Drop type">
            ${hintHtml}
          </div>
          <button
            type="button"
            class="cb-sheet-submit"
            data-cb-action="submit-drop"
            ${canSend ? '' : 'disabled'}
          >
            ${ui.submitting ? 'Dropping…' : `Send ${esc(ui.draftHint)} Drop`}
          </button>
          ${recentHtml}
        </div>
      </div>
    `;
  }

  function renderSurfaceTabsHtml(surfaces, activeId) {
    const list = surfaces.length > 0
      ? surfaces.slice(0, 4)
      : [
          { id: 'floor', name: 'Floor', count: 0, path: '/' },
          { id: 'hopper', name: 'Hopper', count: 0, path: '/#hopper' },
          { id: 'schedule', name: 'Schedule', count: 0, path: '/' },
          { id: 'den', name: 'Den', count: 0, path: '/' },
        ];
    return list
      .map((s) => {
        const isActive = s.id === activeId;
        const count = Number(s.count) || 0;
        const openPath = s.id === 'hopper' ? (s.path && s.path !== '/' ? s.path : '/#hopper') : (s.path || '/');
        return `
          <button
            type="button"
            class="cb-stage-tab ${isActive ? 'cb-is-active' : ''}"
            data-cb-action="open-surface"
            data-cb-surface="${esc(s.id)}"
            data-cb-open-path="${esc(openPath)}"
            aria-current="${isActive ? 'page' : 'false'}"
          >
            <span>${esc(shortSurfaceName(s))}</span>
            ${count > 0 ? `<span class="cb-stage-tab-cnt">${esc(count)}</span>` : ''}
          </button>
        `;
      })
      .join('');
  }

  function render() {
    if (!rootEl) return;
    document.body.classList.toggle('is-surface-open', Boolean(ui.activeSurface));
    if (!hubState) {
      rootEl.innerHTML = '<div class="hub-loading">Loading Crew Dock…</div>';
      return;
    }

    if (ui.activeSurface) {
      const surfaces = Array.isArray(hubState.surfaces) ? hubState.surfaces : [];
      const tabsHtml = renderSurfaceTabsHtml(surfaces, ui.activeSurface.id);
      const existingStage = rootEl.querySelector('.cb-stage-view');
      if (existingStage) {
        const tabsEl = existingStage.querySelector('.cb-stage-tabs');
        if (tabsEl) tabsEl.innerHTML = tabsHtml;
        const popEl = existingStage.querySelector('[data-cb-action="popout-surface"]');
        if (popEl) popEl.setAttribute('href', ui.activeSurface.url);
        const frameEl = existingStage.querySelector('.cb-stage-frame');
        if (frameEl && frameEl.getAttribute('data-src') !== ui.activeSurface.url) {
          frameEl.setAttribute('data-src', ui.activeSurface.url);
          frameEl.setAttribute('src', ui.activeSurface.url);
        }
        return;
      }

      rootEl.innerHTML = `
        <div class="cb-stage-view">
          <header class="cb-stage-bar" role="navigation" aria-label="Crew Dock navigation">
            <button type="button" class="cb-home-btn" data-cb-action="close-surface">
              <span class="cb-home-arrow" aria-hidden="true">←</span>
              <span>Crew Dock</span>
            </button>
            <div class="cb-stage-tabs" role="tablist">
              ${tabsHtml}
            </div>
            <a
              class="cb-popout-btn"
              data-cb-action="popout-surface"
              href="${esc(ui.activeSurface.url)}"
              target="_blank"
              rel="noopener"
              title="Open in separate browser tab"
              aria-label="Open in separate browser tab"
            >↗</a>
          </header>
          <iframe
            class="cb-stage-frame"
            src="${esc(ui.activeSurface.url)}"
            data-src="${esc(ui.activeSurface.url)}"
            title="Live Surface"
          ></iframe>
        </div>
      `;
      return;
    }

    const activeTextarea = rootEl.querySelector('[data-cb-input="drop-text"]');
    const hadFocus = Boolean(activeTextarea && document.activeElement === activeTextarea);
    const selStart = hadFocus ? activeTextarea.selectionStart : null;
    const selEnd = hadFocus ? activeTextarea.selectionEnd : null;

    const crew = Array.isArray(hubState.crew) ? hubState.crew : [];
    const surfaces = Array.isArray(hubState.surfaces) ? hubState.surfaces : [];
    const items = Array.isArray(hubState.items) ? hubState.items : [];
    const drops = Array.isArray(hubState.drops) ? hubState.drops : [];

    const crewMap = new Map(crew.map((c) => [c.id, c]));
    const surfaceMap = new Map(surfaces.map((s) => [s.id, s]));

    if (ui.selectedCrewId && !crewMap.has(ui.selectedCrewId)) {
      ui.selectedCrewId = null;
    }

    const openUrgentFromItems = items.filter((i) => !i.done && isUrgentItem(i)).length;
    const needsCount =
      items.length > 0
        ? openUrgentFromItems
        : typeof hubState.needsCount === 'number'
        ? hubState.needsCount
        : 0;
    const isCalm = needsCount === 0;

    const bannerTitle = isCalm ? 'All Calm' : `${needsCount} Needs You`;
    const bannerSub = isCalm
      ? 'Nothing urgent waiting on you'
      : 'Glance up · thumb-tap below';

    const selectedMember = ui.selectedCrewId ? crewMap.get(ui.selectedCrewId) : null;

    const hudBodyHtml = selectedMember
      ? renderHudCrewFocus(selectedMember, items, crewMap, surfaceMap)
      : renderHudOverview(hubState, items, surfaces, drops, crewMap, surfaceMap);

    const crewCardsHtml = crew
      .slice(0, 4)
      .map((member) => {
        const accent = crewColor(member);
        const selected = ui.selectedCrewId === member.id;
        const dimmed = Boolean(ui.selectedCrewId) && !selected;
        const counts = getAgentCounts(member.id, member, items);
        const pipVal = counts.urgentOpen > 0 ? counts.urgentOpen : counts.totalOpen;
        const pipSoft = counts.urgentOpen === 0 && counts.totalOpen > 0;
        const initial = (member.name || '?').slice(0, 1).toUpperCase();

        return `
          <button
            type="button"
            class="cb-crew-card ${selected ? 'cb-is-selected' : ''} ${dimmed ? 'cb-is-dimmed' : ''}"
            style="--cb-accent:${esc(accent)}"
            data-cb-action="select-crew"
            data-cb-crew="${esc(member.id)}"
            aria-pressed="${selected ? 'true' : 'false'}"
          >
            <div class="cb-crew-fallback" aria-hidden="true">${esc(initial)}</div>
            ${
              member.faceUrl
                ? `<img class="cb-crew-img" src="${esc(member.faceUrl)}" alt="${esc(member.name)}" onerror="this.style.display='none'" />`
                : ''
            }
            <div class="cb-crew-scrim"></div>
            <div class="cb-crew-rim"></div>
            ${selected ? '<span class="cb-crew-sel-tag">Focused</span>' : ''}
            ${
              pipVal > 0
                ? `<span class="cb-crew-pip ${pipSoft ? 'cb-pip-soft' : ''}" title="${pipVal} open">${esc(pipVal)}</span>`
                : ''
            }
            <div class="cb-crew-footer">
              <div class="cb-crew-name-row">
                <span class="cb-crew-dot"></span>
                <span class="cb-crew-name">${esc(member.name)}</span>
              </div>
              <div class="cb-crew-status">${esc(member.statusText || member.role || 'Ready')}</div>
            </div>
          </button>
        `;
      })
      .join('');

    const doorRailHtml = surfaces
      .slice(0, 4)
      .map((s) => {
        const icon = SURFACE_ICONS[s.id] || SURFACE_ICONS.floor;
        const count = Number(s.count) || 0;
        const isNeeds = s.status === 'needs';
        return `
          <button
            type="button"
            class="cb-door-btn ${isNeeds ? 'cb-door-needs' : ''}"
            data-cb-action="open-surface"
            data-cb-surface="${esc(s.id)}"
            data-cb-open-path="${esc(s.path || '/')}"
          >
            ${count > 0 ? `<span class="cb-door-badge">${esc(count)}</span>` : ''}
            ${icon}
            <span class="cb-door-label">${esc(shortSurfaceName(s))}</span>
          </button>
        `;
      })
      .join('');

    rootEl.innerHTML = `
      <div class="cb-root">
        <div class="cb-shell ${isCalm ? 'cb-is-calm' : ''}">
          <div class="cb-hud">
            <header class="cb-banner ${isCalm ? 'cb-state-calm' : 'cb-state-needs'}">
              <div class="cb-banner-left">
                <span class="cb-orb ${isCalm ? 'cb-orb-calm' : 'cb-orb-needs'}" aria-hidden="true"></span>
                <div class="cb-banner-copy">
                  <div class="cb-banner-title">${esc(bannerTitle)}</div>
                  <div class="cb-banner-sub">${esc(bannerSub)}</div>
                </div>
              </div>
              <div class="cb-banner-actions">
                <button
                  type="button"
                  class="cb-toggle-chip ${ui.urgentOnly ? 'cb-is-on' : ''}"
                  data-cb-action="toggle-urgent"
                  aria-pressed="${ui.urgentOnly ? 'true' : 'false'}"
                >
                  <span class="cb-toggle-dot" aria-hidden="true"></span>
                  <span>Only What Needs Me</span>
                </button>
                <button
                  type="button"
                  class="cb-refresh-btn ${ui.refreshing ? 'cb-is-spinning' : ''}"
                  data-cb-action="refresh-hub"
                  title="Refresh Crew Dock"
                  aria-label="Refresh Crew Dock"
                  ${ui.refreshing ? 'disabled' : ''}
                >
                  <span class="cb-refresh-glyph" aria-hidden="true">↻</span>
                </button>
              </div>
            </header>

            ${hudBodyHtml}
          </div>

          <section class="cb-thumb-zone" aria-label="One-Thumb Crew Dock">
            <div class="cb-thumb-head">
              <span class="cb-thumb-label">
                <span class="cb-live-dot ${ui.connected ? '' : 'cb-is-off'}" title="${ui.connected ? 'Live connected' : 'Reconnecting'}"></span>
                <span>Crew Dock · Thumb Zone</span>
              </span>
              <span class="cb-thumb-hint">${selectedMember ? 'Tap again for Radar' : 'Tap a face to focus'}</span>
            </div>

            <div class="cb-crew-grid">
              ${crewCardsHtml}
            </div>

            <nav class="cb-door-rail" aria-label="Quick Surface Doors">
              ${doorRailHtml}
            </nav>

            <button type="button" class="cb-drop-cta" data-cb-action="open-drop">
              <span class="cb-drop-cta-left">
                <span class="cb-drop-plus" aria-hidden="true">+</span>
                <span>Drop to Hopper</span>
              </span>
              <span class="cb-drop-count">${drops.length} ${drops.length === 1 ? 'drop' : 'drops'}</span>
            </button>
          </section>
        </div>
        ${ui.dropOpen ? renderQuickDropSheet(drops) : ''}
      </div>
    `;

    bindSheetInput();

    if (ui.dropOpen && (ui.justOpenedDrop || hadFocus)) {
      ui.justOpenedDrop = false;
      const textarea = rootEl.querySelector('[data-cb-input="drop-text"]');
      if (textarea) {
        textarea.focus();
        const len = textarea.value.length;
        const start = selStart != null ? Math.min(selStart, len) : len;
        const end = selEnd != null ? Math.min(selEnd, len) : len;
        try { textarea.setSelectionRange(start, end); } catch {}
      }
    }
  }

  function bindSheetInput() {
    if (!rootEl) return;
    const textarea = rootEl.querySelector('[data-cb-input="drop-text"]');
    if (!textarea) return;
    textarea.addEventListener('input', (e) => {
      ui.draftText = e.target.value;
      const submitBtn = rootEl.querySelector('[data-cb-action="submit-drop"]');
      if (submitBtn) {
        submitBtn.disabled = ui.draftText.trim().length === 0 || ui.submitting;
      }
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmitDrop();
      }
    });
  }

  async function refreshHub({ fresh = false, announce = false } = {}) {
    if (ui.refreshing && !fresh) return;
    ui.refreshing = true;
    if (announce && hubState) render();
    try {
      const next = await apiJson(fresh ? '/api/hub?fresh=1' : '/api/hub');
      hubState = next;
      if (announce) showToast('Up to date', 'success');
    } catch (err) {
      if (!hubState && rootEl) {
        rootEl.innerHTML = `<div class="hub-empty">Could not load Crew Dock: ${esc(err.message)}</div>`;
      } else if (announce) {
        showToast('Could not reach Foundry', 'warn');
      }
    } finally {
      ui.refreshing = false;
      if (hubState) render();
    }
  }

  async function handleTriage(itemId) {
    if (!itemId || ui.busyIds.has(itemId)) return;
    const prevItem = hubState?.items?.find((it) => it.id === itemId);
    ui.busyIds.add(itemId);
    render();
    try {
      const res = await apiJson('/api/hub/ack', {
        method: 'POST',
        body: JSON.stringify({ id: itemId }),
      });
      if (res && res.state) {
        hubState = res.state;
      } else {
        await refreshHub({ fresh: true });
      }
      const nowItem = hubState?.items?.find((it) => it.id === itemId);
      if (nowItem?.done || res?.done === true) {
        showToast(`Handled: ${(nowItem || prevItem)?.title || 'Item'}`, 'success');
      } else {
        showToast(`Reopened: ${(nowItem || prevItem)?.title || 'Item'}`, 'warn');
      }
    } catch (_err) {
      showToast('Could not save status — try again', 'warn');
    } finally {
      ui.busyIds.delete(itemId);
      render();
    }
  }

  async function handleSubmitDrop() {
    const text = ui.draftText.trim();
    if (!text || ui.submitting) return;
    ui.submitting = true;
    render();
    try {
      const res = await apiJson('/api/hub/drop', {
        method: 'POST',
        body: JSON.stringify({ text, hint: ui.draftHint }),
      });
      ui.draftText = '';
      ui.dropOpen = false;
      if (res && res.state) {
        hubState = res.state;
      } else {
        await refreshHub({ fresh: true });
      }
      showToast('Dropped straight into Hopper', 'success');
    } catch (_err) {
      showToast('Drop failed — try again', 'warn');
    } finally {
      ui.submitting = false;
      render();
    }
  }

  function closeActiveSurface({ fromPopState = false } = {}) {
    if (!ui.activeSurface) return;
    ui.activeSurface = null;
    if (!fromPopState && window.location.hash.startsWith('#view=')) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {}
    }
    render();
  }

  function handleOpenSurface(surfaceId, openPath, openKind) {
    const url = resolveSurfaceUrl(surfaceId, openPath, openKind);
    if (!url) return;
    const wasOpen = Boolean(ui.activeSurface);
    ui.activeSurface = {
      id: openKind === 'link' ? 'link' : surfaceId,
      url,
      openPath: openPath || '',
      openKind: openKind || '',
    };
    const nextHash = `#view=${encodeURIComponent(ui.activeSurface.id)}`;
    try {
      if (wasOpen) {
        window.history.replaceState({ crewDockSurface: ui.activeSurface.id }, '', nextHash);
      } else {
        window.history.pushState({ crewDockSurface: ui.activeSurface.id }, '', nextHash);
      }
    } catch {}
    render();
  }

  if (rootEl) {
    rootEl.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-cb-action]');
      if (!target) return;

      const action = target.getAttribute('data-cb-action');

      if (action === 'close-drop-backdrop') {
        if (e.target !== target) return;
        ui.dropOpen = false;
        render();
        return;
      }

      if (action === 'close-drop') {
        ui.dropOpen = false;
        render();
        return;
      }

      if (action === 'open-drop') {
        ui.dropOpen = true;
        ui.justOpenedDrop = true;
        render();
        return;
      }

      if (action === 'pick-hint') {
        const hint = target.getAttribute('data-cb-hint');
        if (hint) {
          ui.draftHint = hint;
          ui.justOpenedDrop = true;
          render();
        }
        return;
      }

      if (action === 'submit-drop') {
        await handleSubmitDrop();
        return;
      }

      if (action === 'toggle-urgent') {
        ui.urgentOnly = !ui.urgentOnly;
        render();
        return;
      }

      if (action === 'refresh-hub') {
        await refreshHub({ fresh: true, announce: true });
        return;
      }

      if (action === 'select-crew') {
        const crewId = target.getAttribute('data-cb-crew');
        ui.selectedCrewId = ui.selectedCrewId === crewId ? null : crewId;
        render();
        return;
      }

      if (action === 'clear-crew') {
        ui.selectedCrewId = null;
        render();
        return;
      }

      if (action === 'close-surface') {
        closeActiveSurface();
        return;
      }

      if (action === 'popout-surface') {
        return;
      }

      if (action === 'open-surface') {
        const surfaceId = target.getAttribute('data-cb-surface');
        const openPath = target.getAttribute('data-cb-open-path') || '';
        const openKind = target.getAttribute('data-cb-open-kind') || '';
        if (surfaceId) {
          handleOpenSurface(surfaceId, openPath, openKind);
        }
        return;
      }

      if (action === 'triage') {
        const itemId = target.getAttribute('data-cb-id');
        if (itemId) {
          await handleTriage(itemId);
        }
      }
    });
  }

  window.addEventListener('popstate', () => {
    if (ui.activeSurface && !window.location.hash.startsWith('#view=')) {
      closeActiveSurface({ fromPopState: true });
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.dropOpen) {
      ui.dropOpen = false;
      render();
      return;
    }
    if (e.key === 'Escape' && ui.activeSurface) {
      closeActiveSurface();
    }
  });

  function scheduleSseRefresh() {
    if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
    sseDebounceTimer = setTimeout(() => {
      refreshHub({ fresh: false });
    }, 320);
  }

  function connectEvents() {
    try {
      const es = new EventSource('/api/events');
      es.onopen = () => {
        ui.connected = true;
        if (lostLine) {
          lostLine = false;
          refreshHub({ fresh: true });
        } else if (hubState) {
          render();
        }
      };
      es.onmessage = (ev) => {
        ui.connected = true;
        const m = /^hello (\S+)/.exec(ev.data || '');
        if (m) {
          if (bootSeen && bootSeen !== m[1]) {
            window.location.reload();
            return;
          }
          bootSeen = m[1];
          return;
        }
        scheduleSseRefresh();
      };
      es.onerror = () => {
        ui.connected = false;
        lostLine = true;
        if (hubState) render();
      };
    } catch {
      // EventSource unavailable
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastVisRefresh < 2000) return;
    lastVisRefresh = now;
    refreshHub({ fresh: true });
  });

  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - lastVisRefresh < 3000) return;
    lastVisRefresh = now;
    refreshHub({ fresh: false });
  });

  // Expose resolver for diagnostic checks
  window.__CREW_DOCK__ = { resolveSurfaceUrl };

  refreshHub({ fresh: false }).then(() => {
    connectEvents();
  });
})();
