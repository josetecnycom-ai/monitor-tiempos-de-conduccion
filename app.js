/*
 * MyGeotab page Add-In entry point and dashboard UI.
 * The Geotab Add-In API is injected by the host; there is no demo fleet data.
 */
(() => {
  'use strict';

  const REFRESH_MS = 60_000;
  const WARNING_SECONDS = 10 * 60;
  const LIMITS = {
    continuous: 4.5 * 3600,
    dailyNormal: 9 * 3600,
    dailyExtended: 10 * 3600,
    weekly: 56 * 3600,
    biweekly: 90 * 3600
  };
  const $ = (selector) => document.querySelector(selector);
  const els = {};
  let api = null;
  let refreshTimer = null;
  let loadInProgress = false;
  let drivers = [];
  let alerts = [];
  let latestStatus = [];
  let pendingActivityChecks = 0;
  let shownAlertKeys = new Set();
  let uiBound = false;
  const activityEligibilityCache = new Map();
  const ACTIVITY_CACHE_MS = 10 * 60 * 1000;
  const ACTIVITY_RETRY_MS = 60 * 1000;
  const MAX_ACTIVITY_CHECKS_PER_REFRESH = 60;
  let activityCursor = 0;
  let alertPrefs = { preventive: true, exceeded: true };

  function initElements() {
    Object.assign(els, {
      active: $('#active-count'), upcoming: $('#upcoming-count'), drivers: $('#driver-count'),
      lastCheck: $('#last-check'), body: $('#drivers-body'), summary: $('#table-summary'),
      alerts: $('#alert-list'), search: $('#search'), statusFilter: $('#alert-filter'),
      filters: $('#filters'), filterCount: $('#filter-count'), toastRegion: $('#toast-region'),
      dialog: $('#settings-dialog')
    });
    try {
      const prefs = JSON.parse(localStorage.getItem('drivingTimesPrefs') || '{}');
      alertPrefs = { ...alertPrefs, ...prefs };
      $('#pre-alert').checked = alertPrefs.preventive;
      $('#over-alert').checked = alertPrefs.exceeded;
    } catch (_) { /* Ignore invalid local preferences. */ }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h} h ${String(m).padStart(2, '0')} min`;
  }

  function secondsLeft(status, availableKey, elapsedKey, limitKey) {
    const available = Number(status[availableKey]);
    if (Number.isFinite(available) && available >= 0) return available;
    const elapsed = Number(status[elapsedKey]);
    const limit = Number(status[limitKey]);
    return Number.isFinite(elapsed) && Number.isFinite(limit) ? limit - elapsed : null;
  }

  async function callGet(typeName, search, fields) {
    const params = { typeName, search };
    if (fields) params.propertySelector = { fields };
    return api.call('Get', params);
  }

  async function loadStatus() {
    if (!api || loadInProgress) return;
    loadInProgress = true;
    setConnection('Cargando datos…', false);
    try {
      // This endpoint is documented in the supplied Tachograph API guide.
      latestStatus = await callGet('TachographDrivingTimeStatus', {});
      const now = Date.now();
      // Build an explicit allow-list from active drivers instead of trusting
      // every user returned by the tachograph status feed.
      const users = await callGet('User', {
        userSearchType: 'Driver',
        fromDate: new Date(now).toISOString()
      }, ['id', 'name', 'firstName', 'lastName', 'isDriver', 'activeFrom', 'activeTo', 'driverGroups']);
      const userById = new Map(users
        .filter((user) => user.isDriver === true && isActiveUser(user, now))
        .map((user) => [user.id, user]));
      // The tachograph status endpoint can include archived drivers. Keep only
      // rows that match a currently active MyGeotab User record.
      const activeStatus = latestStatus.filter((row) => userById.has(row.user?.id));
      setConnection('Comprobando actividad de los últimos 7 días…', false);
      let activityResult = { eligible: new Set(), pending: 0, error: null };
      if (activeStatus.length) {
        const fromDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
        const toDate = new Date(now).toISOString();
        activityResult = await getRecentDrivingActivity(activeStatus, fromDate, toDate, now);
        pendingActivityChecks = activityResult.pending;
        latestStatus = activeStatus.filter((row) => activityResult.eligible.has(row.user?.id));
      } else {
        latestStatus = [];
        pendingActivityChecks = 0;
      }
      const vehicleIds = [...new Set(latestStatus.map((row) => row.activityLastVehicle).filter(Boolean))];
      const devices = vehicleIds.length ? await callGet('Device', { deviceIds: vehicleIds }, ['id', 'name', 'licensePlate']) : [];
      const deviceById = new Map(devices.map((device) => [device.id, device]));
      drivers = latestStatus.map((row) => normalizeDriver(row, userById.get(row.user?.id), deviceById.get(row.activityLastVehicle)));
      alerts = evaluateAlerts(drivers);
      render();
      announceNewAlerts(alerts);
      els.lastCheck.textContent = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date());
      setConnection(activityResult.error ? 'Vigilancia parcial · límite API' : 'Vigilancia activa', !activityResult.error);
      if (activityResult.pending && !activityResult.error) {
        console.info(`${activityResult.pending} conductores pendientes de comprobar actividad reciente.`);
      }
      if (activityResult.error) console.warn('No se pudieron comprobar todos los conductores por el límite de consultas.', activityResult.error);
    } catch (error) {
      console.error('No se pudo consultar el estado del tacógrafo.', error);
      setConnection('Sin conexión', false);
      if (!drivers.length) showLoadError(error);
      toast('No se pudieron actualizar los datos de tacógrafo.', 'error');
    } finally {
      loadInProgress = false;
    }
  }

  async function getRecentDrivingActivity(rows, fromDate, toDate, now) {
    const uniqueIds = [...new Set(rows.map((row) => row.user?.id).filter(Boolean))];
    const dueIds = uniqueIds.filter((id) => {
      const cached = activityEligibilityCache.get(id);
      if (!cached) return true;
      return cached.eligible === null
        ? now - cached.checkedAt >= ACTIVITY_RETRY_MS
        : now - cached.checkedAt >= ACTIVITY_CACHE_MS;
    });
    const startAt = uniqueIds.length ? activityCursor % uniqueIds.length : 0;
    const rotatedDue = dueIds.filter((id) => uniqueIds.indexOf(id) >= startAt)
      .concat(dueIds.filter((id) => uniqueIds.indexOf(id) < startAt));
    const selectedIds = rotatedDue.slice(0, MAX_ACTIVITY_CHECKS_PER_REFRESH);
    if (selectedIds.length && uniqueIds.length) activityCursor = (uniqueIds.indexOf(selectedIds[selectedIds.length - 1]) + 1) % uniqueIds.length;
    let error = null;
    // TachographDriverActivity is rate-limited, so send bounded batches via the
    // API. multiCall reduces transport overhead, but each inner request still
    // counts against the endpoint quota.
    if (selectedIds.length) {
      const calls = selectedIds.map((id) => ['Get', {
        typeName: 'TachographDriverActivity',
        search: { type: 'COMBINE', extrapolate: true, userSearch: { id }, fromDate, toDate }
      }]);
      try {
        const results = await multiCall(calls);
        results.forEach((events, index) => {
          const hasDriving = Array.isArray(events) && events.some((event) => String(event.activity || '').toUpperCase() === 'DRIVING');
          activityEligibilityCache.set(selectedIds[index], { eligible: hasDriving, checkedAt: now });
        });
      } catch (cause) {
        error = cause;
        selectedIds.forEach((id) => activityEligibilityCache.set(id, { eligible: null, checkedAt: now }));
      }
    }
    const eligible = new Set(uniqueIds.filter((id) => activityEligibilityCache.get(id)?.eligible === true));
    const pending = uniqueIds.filter((id) => {
      const cached = activityEligibilityCache.get(id);
      return !cached || cached.eligible === null || now - cached.checkedAt >= ACTIVITY_CACHE_MS;
    }).length;
    return { eligible, pending, error };
  }

  function multiCall(calls) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const success = (value) => { if (!settled) { settled = true; resolve(value); } };
      const failure = (error) => { if (!settled) { settled = true; reject(error); } };
      try {
        const result = api.multiCall(calls, success, failure);
        if (result && typeof result.then === 'function') result.then(success, failure);
      } catch (error) {
        failure(error);
      }
    });
  }

  function isActiveUser(user, now) {
    const activeFrom = user.activeFrom ? Date.parse(user.activeFrom) : NaN;
    const activeTo = user.activeTo ? Date.parse(user.activeTo) : NaN;
    return (!Number.isFinite(activeFrom) || activeFrom <= now) &&
      (!Number.isFinite(activeTo) || activeTo > now);
  }

  function normalizeDriver(status, user, device) {
    // PendingBreakTime is not documented as a remaining driving allowance.
    const continuousLeft = LIMITS.continuous - (Number(status.continuousDrivingTime) || 0);
    const dailyLeft = secondsLeft(status, 'dailyDrivingAvailableTime', 'dailyDrivingTime', 'dailyDrivingTimeLimit');
    const weeklyLeft = secondsLeft(status, 'weeklyDrivingAvailableTime', 'cumulatedWeeklyDrivingTime', null);
    const biweeklyLeft = secondsLeft(status, 'biweeklyDrivingAvailableTime', 'cumulatedBiweeklyDrivingTime', null);
    return {
      id: status.user?.id,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || status.user?.id || 'Conductor sin nombre',
      vehicle: device?.licensePlate || device?.name || status.activityLastVehicle || 'Sin vehículo asociado',
      activity: status.activityStatus || status.workActivityStatus || 'UNKNOWN',
      continuous: Number(status.continuousDrivingTime) || 0,
      continuousLeft,
      daily: Number(status.dailyDrivingTime) || 0,
      dailyLeft,
      dailyLimit: Number(status.dailyDrivingTimeLimit) || LIMITS.dailyNormal,
      weekly: Number(status.cumulatedWeeklyDrivingTime) || 0,
      weeklyLeft,
      biweekly: Number(status.cumulatedBiweeklyDrivingTime) || 0,
      biweeklyLeft,
      restStart: status.restActivityStart,
      restDuration: Number(status.restDuration) || 0,
      dailyRestType: status.dailyRestType,
      dailyRestMinimum: status.dailyDrivingRestMinType,
      nextRestStartLimit: status.nextRestMaxStartTime,
      weeklyRestStartLimit: status.weeklyRestMaxStartTime,
      pendingCompensations: Number(status.pendingCompensations) || 0,
      nextCompensationDuration: Number(status.nextCompensationDuration) || 0,
      statusUnknown: String(status.activityStatus || '').toUpperCase() === 'UNKNOWN',
      hasZeroCounters: ['continuousDrivingTime', 'dailyDrivingTime', 'cumulatedWeeklyDrivingTime'].every((key) => Number(status[key]) === 0),
      activityEvidence: true
    };
  }

  function thresholdAlerts(driver) {
    const thresholds = [
      ['continuous', 'Conducción continua', driver.continuousLeft, LIMITS.continuous],
      ['daily', 'Conducción diaria', driver.dailyLeft, driver.dailyLimit || LIMITS.dailyNormal],
      ['weekly', 'Conducción semanal', driver.weeklyLeft, LIMITS.weekly],
      ['biweekly', 'Conducción bisemanal', driver.biweeklyLeft, LIMITS.biweekly]
    ];
    return thresholds.filter(([, , left]) => left !== null && left <= WARNING_SECONDS)
      .map(([key, label, left, limit]) => ({ driver, key, label, left, exceeded: left < 0, limit }));
  }

  function evaluateAlerts(rows) {
    const result = [];
    for (const driver of rows) {
      for (const item of thresholdAlerts(driver)) {
        const type = item.exceeded ? 'exceeded' : 'preventive';
        if (!alertPrefs[type]) continue;
        result.push({ ...item, type, key: `${driver.id}:${item.key}:${type}` });
      }
    }
    return result.sort((a, b) => (a.exceeded === b.exceeded ? a.left - b.left : Number(b.exceeded) - Number(a.exceeded)));
  }

  function render() {
    const active = alerts.filter((item) => item.exceeded).length;
    const upcoming = alerts.filter((item) => !item.exceeded).length;
    els.active.textContent = String(active);
    els.upcoming.textContent = String(upcoming);
    els.drivers.textContent = String(drivers.length);
    renderTable();
    renderAlerts();
  }

  function renderTable() {
    const query = (els.search?.value || '').trim().toLocaleLowerCase('es');
    const filter = els.statusFilter?.value || 'all';
    const filtered = drivers.filter((driver) => {
      if (query && !`${driver.name} ${driver.vehicle}`.toLocaleLowerCase('es').includes(query)) return false;
      const driverAlerts = alerts.filter((item) => item.driver.id === driver.id);
      if (filter === 'active' && !driverAlerts.some((item) => item.exceeded)) return false;
      if (filter === 'upcoming' && !driverAlerts.some((item) => !item.exceeded)) return false;
      if (filter === 'ok' && driverAlerts.length) return false;
      return true;
    });
    if (!filtered.length) {
      const checking = !drivers.length && pendingActivityChecks > 0;
      els.body.innerHTML = `<tr><td colspan="6" class="empty-state"><strong>${drivers.length ? 'No hay resultados' : checking ? 'Comprobando actividad reciente' : 'Sin actividad de conducción reciente'}</strong><span>${drivers.length ? 'Prueba a cambiar el filtro o la búsqueda.' : checking ? `Quedan ${pendingActivityChecks} conductores por comprobar; se procesan por tandas para respetar el límite de la API.` : 'Solo se muestran conductores activos con actividad DRIVING del tacógrafo en los últimos 7 días.'}</span></td></tr>`;
    } else {
      els.body.innerHTML = filtered.map((driver) => {
        const statusAlerts = alerts.filter((item) => item.driver.id === driver.id);
        const severe = statusAlerts.some((item) => item.exceeded);
        const unavailable = driver.statusUnknown && driver.hasZeroCounters;
        const badge = severe ? '<span class="badge badge-red">Límite superado</span>' : statusAlerts.length ? '<span class="badge badge-amber">Próximo límite</span>' : unavailable ? '<span class="badge badge-gray">Datos no confirmados</span>' : '<span class="badge badge-green">Dentro de límite</span>';
        const evidence = unavailable && driver.activityEvidence
          ? 'Actividad DRIVING registrada en los últimos 7 días; resumen de estado sin confirmar'
          : unavailable ? 'Estado del tacógrafo desconocido; no se muestran ceros como tiempos válidos' : escapeHtml(driver.activity);
        const continuous = unavailable ? '—' : formatDuration(driver.continuous);
        const daily = unavailable ? '—' : formatDuration(driver.daily);
        const weekly = unavailable ? '—' : formatDuration(driver.weekly);
        const biweekly = unavailable ? '—' : formatDuration(driver.biweekly);
        const left = (value, label) => unavailable ? 'Sin datos confirmados' : remainingLabel(value, label);
        return `<tr><td><strong class="driver-name">${escapeHtml(driver.name)}</strong><small class="cell-sub">${evidence}</small></td><td>${escapeHtml(driver.vehicle)}</td><td>${continuous}<small class="cell-sub">${left(driver.continuousLeft, 'pausa')}</small></td><td>${daily}<small class="cell-sub">${left(driver.dailyLeft, 'disponibles')}</small></td><td>${weekly}<small class="cell-sub">${left(driver.weeklyLeft, 'semanales')} · ${biweekly} 2 sem.</small></td><td>${badge}</td></tr>`;
      }).join('');
    }
    els.summary.textContent = `${filtered.length} de ${drivers.length} conductores`;
  }

  function remainingLabel(seconds, suffix) {
    if (seconds === null) return 'Tiempo disponible no informado';
    return seconds < 0 ? `${formatDuration(-seconds)} sobre límite` : `${formatDuration(seconds)} ${suffix}`;
  }

  function renderAlerts() {
    if (!alerts.length) {
      els.alerts.innerHTML = `<div class="empty-alert"><div class="empty-check"><svg viewBox="0 0 24 24"><path d="m5 12 4.3 4.3L19 6.8"/></svg></div><strong>Sin avisos por ahora</strong><span>La vigilancia se mantiene activa mientras esta sesión de MyGeotab está abierta.</span></div>`;
      return;
    }
    els.alerts.innerHTML = alerts.slice(0, 12).map((item) => `<article class="alert-item ${item.exceeded ? 'alert-danger' : 'alert-warning'}"><span class="alert-symbol">${item.exceeded ? '!' : '◷'}</span><div><strong>${escapeHtml(item.label)} ${item.exceeded ? 'superada' : 'próxima'}</strong><span>${escapeHtml(item.driver.name)} · ${escapeHtml(item.driver.vehicle)}</span><small>${item.exceeded ? `${formatDuration(-item.left)} por encima del límite` : `Quedan ${formatDuration(item.left)}`}</small></div></article>`).join('');
  }

  function announceNewAlerts(items) {
    const currentKeys = new Set(items.map((item) => item.key));
    for (const item of items) {
      if (shownAlertKeys.has(item.key)) continue;
      const lead = item.exceeded ? 'Límite superado' : 'Aviso preventivo';
      const detail = item.exceeded ? `${formatDuration(-item.left)} por encima` : `Quedan ${formatDuration(item.left)}`;
      toast(`${lead}: ${item.label} · ${item.driver.name} · ${detail}`, item.exceeded ? 'error' : '');
    }
    shownAlertKeys = currentKeys;
  }

  function showLoadError(error) {
    const message = String(error?.message || 'Comprueba la sesión y los permisos de tacógrafo.');
    els.body.innerHTML = `<tr><td colspan="6" class="empty-state"><strong>No se pudo cargar la flota</strong><span>${escapeHtml(message)}</span></td></tr>`;
    els.alerts.innerHTML = `<div class="empty-alert"><strong>Vigilancia sin datos</strong><span>Se necesita permiso de lectura del estado de tacógrafo en MyGeotab.</span></div>`;
    els.summary.textContent = 'No se pudieron cargar los conductores';
  }

  function setConnection(label, active) {
    const target = document.querySelector('.connection');
    if (target) target.innerHTML = `<i style="${active ? '' : 'background:#c58a2e;box-shadow:0 0 0 3px #c58a2e1b'}"></i><span>${escapeHtml(label)}</span>`;
  }

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    els.toastRegion.appendChild(node);
    window.setTimeout(() => node.remove(), 4500);
  }

  function startMonitoring() {
    stopMonitoring();
    loadStatus();
    refreshTimer = window.setInterval(loadStatus, REFRESH_MS);
  }

  function stopMonitoring() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    $('#refresh').addEventListener('click', () => loadStatus());
    $('#filters-button').addEventListener('click', () => { els.filters.hidden = !els.filters.hidden; });
    els.search.addEventListener('input', renderTable);
    els.statusFilter.addEventListener('change', renderTable);
    $('#settings-button').addEventListener('click', () => els.dialog.showModal());
    const setSummaryFilter = (value) => {
      els.filters.hidden = false;
      els.statusFilter.value = value;
      renderTable();
      document.querySelector('.drivers-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const bindCard = (selector, filter) => {
      const card = $(selector);
      card.addEventListener('click', () => setSummaryFilter(filter));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setSummaryFilter(filter);
        }
      });
    };
    bindCard('#active-card', 'active');
    bindCard('#upcoming-card', 'upcoming');
    bindCard('#drivers-card', 'all');
    $('#show-all').addEventListener('click', () => {
      els.filters.hidden = false;
      els.statusFilter.value = 'active';
      renderTable();
      document.querySelector('.drivers-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#settings-dialog form').addEventListener('submit', (event) => {
      if (event.submitter?.value !== 'save') return;
      alertPrefs = { preventive: $('#pre-alert').checked, exceeded: $('#over-alert').checked };
      localStorage.setItem('drivingTimesPrefs', JSON.stringify(alertPrefs));
      alerts = evaluateAlerts(drivers);
      render();
      toast('Preferencias guardadas en este navegador.', 'success');
    });
  }

  function initializeGeotab() {
    window.geotab = window.geotab || {};
    window.geotab.addin = window.geotab.addin || {};
    window.geotab.addin.drivingTimes = () => ({
      initialize(geotabApi, state, callback) {
        api = geotabApi;
        initElements();
        bindUi();
        callback();
      },
      focus() { if (api) startMonitoring(); },
      blur() { stopMonitoring(); }
    });
  }

  initializeGeotab();
  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    bindUi();
    // Helpful state if opened outside the host: explicitly show integration isn't connected.
    window.setTimeout(() => {
      if (!api) {
        setConnection('Esperando sesión de MyGeotab', false);
        els.body.innerHTML = '<tr><td colspan="6" class="empty-state"><strong>Abre este add-in desde MyGeotab</strong><span>Los datos de flota se cargan usando tu sesión y permisos de MyGeotab.</span></td></tr>';
        els.summary.textContent = 'Sesión de MyGeotab no detectada';
        els.lastCheck.textContent = 'Sin sesión';
      }
    }, 1200);
  });
})();
