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
  let drivers = [];
  let alerts = [];
  let latestStatus = [];
  let shownAlertKeys = new Set();
  let uiBound = false;
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
    if (!api) return;
    setConnection('Cargando datos…', false);
    try {
      // This endpoint is documented in the supplied Tachograph API guide.
      latestStatus = await callGet('TachographDrivingTimeStatus', {});
      const ids = latestStatus.map((row) => row.user?.id).filter(Boolean);
      const users = ids.length ? await callGet('User', { userIds: ids }, ['id', 'name', 'firstName', 'lastName', 'isDriver', 'driverGroups']) : [];
      const userById = new Map(users.map((user) => [user.id, user]));
      const vehicleIds = [...new Set(latestStatus.map((row) => row.activityLastVehicle).filter(Boolean))];
      const devices = vehicleIds.length ? await callGet('Device', { deviceIds: vehicleIds }, ['id', 'name', 'licensePlate']) : [];
      const deviceById = new Map(devices.map((device) => [device.id, device]));
      drivers = latestStatus.map((row) => normalizeDriver(row, userById.get(row.user?.id), deviceById.get(row.activityLastVehicle)));
      alerts = evaluateAlerts(drivers);
      render();
      announceNewAlerts(alerts);
      els.lastCheck.textContent = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date());
      setConnection('Vigilancia activa', true);
    } catch (error) {
      console.error('No se pudo consultar el estado del tacógrafo.', error);
      setConnection('Sin conexión', false);
      if (!drivers.length) showLoadError(error);
      toast('No se pudieron actualizar los datos de tacógrafo.', 'error');
    }
  }

  function normalizeDriver(status, user, device) {
    // PendingBreakTime is not documented as a remaining driving allowance.
    const continuousLeft = LIMITS.continuous - (Number(status.continuousDrivingTime) || 0);
    const dailyLeft = secondsLeft(status, 'dailyDrivingAvailableTime', 'dailyDrivingTime', 'dailyDrivingTimeLimit');
    const weeklyLeft = secondsLeft(status, 'weeklyDrivingAvailableTime', 'cumulatedWeeklyDrivingTime', null);
    const biweeklyLeft = secondsLeft(status, 'biweeklyDrivingAvailableTime', 'cumulatedBiweeklyDrivingTime', null);
    return {
      id: status.user?.id,
      name: user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || status.user?.id || 'Conductor',
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
      nextCompensationDuration: Number(status.nextCompensationDuration) || 0
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
      els.body.innerHTML = `<tr><td colspan="6" class="empty-state"><strong>${drivers.length ? 'No hay resultados' : 'No hay conductores disponibles'}</strong><span>${drivers.length ? 'Prueba a cambiar el filtro o la búsqueda.' : 'Comprueba que los conductores tengan datos de tacógrafo y permisos de acceso.'}</span></td></tr>`;
    } else {
      els.body.innerHTML = filtered.map((driver) => {
        const statusAlerts = alerts.filter((item) => item.driver.id === driver.id);
        const severe = statusAlerts.some((item) => item.exceeded);
        const badge = severe ? '<span class="badge badge-red">Límite superado</span>' : statusAlerts.length ? '<span class="badge badge-amber">Próximo límite</span>' : '<span class="badge badge-green">Dentro de límite</span>';
        return `<tr><td><strong class="driver-name">${escapeHtml(driver.name)}</strong><small class="cell-sub">${escapeHtml(driver.activity)}</small></td><td>${escapeHtml(driver.vehicle)}</td><td>${formatDuration(driver.continuous)}<small class="cell-sub">${remainingLabel(driver.continuousLeft, 'pausa')}</small></td><td>${formatDuration(driver.daily)}<small class="cell-sub">${remainingLabel(driver.dailyLeft, 'disponibles')}</small></td><td>${formatDuration(driver.weekly)}<small class="cell-sub">${remainingLabel(driver.weeklyLeft, 'semanales')} · ${formatDuration(driver.biweekly)} 2 sem.</small></td><td>${badge}</td></tr>`;
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
