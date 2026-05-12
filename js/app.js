// Lytx DVIR Compliance Add-In
geotab.addin.dvirCompliance = function(api, state) {
  return {
    initialize: function(api, state, callback) {
      callback();
    },
    focus: function(api, state) {
      DVIRApp.init(api, state);
    },
    blur: function(api, state) {}
  };
};

var DVIRApp = (function() {
  'use strict';

  // ── Shared state ────────────────────────────────────────────────────────────
  var _api            = null;
  var _state          = null;
  var _isMetric       = true;
  var _groupMap       = {};        // id -> { name, parent, children[] }
  var _selectedGroupId = null;
  var _navGroupId      = null;

  // ── Daily state ──────────────────────────────────────────────────────────────
  var _allRows      = [];
  var _filteredRows = [];
  var _activeFilter = 'all';
  var _page         = 1;
  var _pageSize     = 50;

  // ── Monthly state ────────────────────────────────────────────────────────────
  var _activeTab      = 'daily';   // 'daily' | 'monthly'
  var _mAllRows       = [];        // aggregated monthly rows
  var _mFilteredRows  = [];
  var _mActiveFilter  = 'all';
  var _mPage          = 1;
  var _mDayTotals     = [];        // [{day, compliant, notcompliant, noinspection}] for chart

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Geotab built-in group IDs always match /^Group[A-Z]/
  function _isBuiltinGroup(gid) {
    return /^Group[A-Z]/.test(gid);
  }

  function _fmt(m) {
    if (!m) return '0';
    return _isMetric ? m.toFixed(1) + ' km' : (m / 1.60934).toFixed(1) + ' mi';
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Returns last day of month as Date — e.g. _lastDayOfMonth(2026, 4) → 30
  function _lastDayOfMonth(yyyy, mm) {
    // mm is 1-based; new Date(yyyy, mm, 0) gives last day of month mm
    return new Date(yyyy, mm, 0).getDate();
  }

  // Returns short day-of-week name for a date string YYYY-MM-DD
  function _dowName(dateStr) {
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
    return days[d.getUTCDay()];
  }

  // Returns month name for display, e.g. '2026-04' → 'April 2026'
  function _monthLabel(ym) {
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var parts = ym.split('-');
    return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }

  // ── Initialisation ────────────────────────────────────────────────────────────

  function init(api, state) {
    _api   = api;
    _state = state;

    // Set today's date on the daily date input
    var t    = new Date();
    var yyyy = t.getUTCFullYear();
    var mm   = String(t.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(t.getUTCDate()).padStart(2, '0');
    var dateEl = document.getElementById('reportDate');
    if (dateEl) dateEl.value = yyyy + '-' + mm + '-' + dd;

    // Fetch user prefs and groups in parallel
    _api.multiCall([
      ['Get', { typeName: 'User',  search: {} }],
      ['Get', { typeName: 'Group', search: {} }]
    ], function(results) {
      var users  = results[0] || [];
      var groups = results[1] || [];
      if (users[0]) { _isMetric = users[0].isMetric !== false; }
      _buildGroupTree(groups, users[0]);
      run();
    }, function() {
      run();
    });
  }

  // ── Group tree ────────────────────────────────────────────────────────────────

  function _buildGroupTree(groups, user) {
    _groupMap = {};
    groups.forEach(function(g) {
      var childIds = (g.children || []).map(function(c) { return c.id; });
      _groupMap[g.id] = { id: g.id, name: g.name || g.id, parent: null, children: childIds };
    });

    Object.keys(_groupMap).forEach(function(gid) {
      _groupMap[gid].children.forEach(function(cid) {
        if (_groupMap[cid]) _groupMap[cid].parent = gid;
      });
    });

    var topGroup = null;

    if (_groupMap['GroupCompanyId']) {
      var companyChildren = _groupMap['GroupCompanyId'].children || [];
      for (var i = 0; i < companyChildren.length; i++) {
        if (!_isBuiltinGroup(companyChildren[i])) { topGroup = companyChildren[i]; break; }
      }
    }

    if (!topGroup && user && user.companyGroups && user.companyGroups.length > 0) {
      for (var j = 0; j < user.companyGroups.length; j++) {
        var ugid = user.companyGroups[j].id;
        if (!_isBuiltinGroup(ugid)) { topGroup = ugid; break; }
      }
    }

    if (!topGroup) {
      var roots = Object.keys(_groupMap).filter(function(gid) {
        return !_isBuiltinGroup(gid) && !_groupMap[gid].parent;
      });
      if (roots.length > 0) topGroup = roots[0];
    }

    _selectedGroupId = topGroup;
    _navGroupId      = topGroup;
    _populateGroupDropdown(topGroup);
  }

  function _populateGroupDropdown(selectedId) {
    var lbl = document.getElementById('groupFilterLabel');
    if (!lbl) return;
    var g = _groupMap[selectedId];
    lbl.textContent  = g ? g.name : 'All Groups';
    _selectedGroupId = selectedId;
  }

  function _renderGroupPanel() {
    var panel = document.getElementById('groupPanel');
    if (!panel) return;
    panel.onclick = function(e) { e.stopPropagation(); };

    var currentId = _navGroupId || _selectedGroupId;
    var current   = _groupMap[currentId];
    var parentId  = current && current.parent && !_isBuiltinGroup(current.parent) ? current.parent : null;
    var children  = [];
    if (current && current.children) {
      current.children.forEach(function(cid) {
        if (!_isBuiltinGroup(cid) && _groupMap[cid]) children.push(cid);
      });
    }

    var html = '<div class="gp-header">';
    if (parentId) {
      html += '<button class="gp-back" onclick="DVIRApp.groupNav(\'' + parentId + '\')">&#8592; Back</button>';
    }
    html += '<span class="gp-header-name">' + _esc((current && current.name) || 'Groups') + '</span></div>';

    var isSelected = (currentId === _selectedGroupId);
    html += '<div class="gp-item gp-select' + (isSelected ? ' gp-selected' : '') + '" onclick="DVIRApp.groupSelect(\'' + currentId + '\')">'
          + (isSelected ? '&#10003; ' : '') + 'All of <strong>' + _esc((current && current.name) || '') + '</strong></div>';

    if (children.length > 0) {
      children.forEach(function(cid) {
        var cg       = _groupMap[cid];
        var hasKids  = cg.children && cg.children.filter(function(k) { return !_isBuiltinGroup(k); }).length > 0;
        var childSel = (cid === _selectedGroupId);
        html += '<div class="gp-item' + (childSel ? ' gp-selected' : '') + '" onclick="DVIRApp.groupNav(\'' + cid + '\')">'
              + '<span>' + (childSel ? '&#10003; ' : '') + _esc(cg.name) + '</span>'
              + (hasKids ? '<span class="gp-arrow">&#8250;</span>' : '')
              + '</div>';
      });
    } else {
      html += '<div class="gp-empty">No sub-groups</div>';
    }
    panel.innerHTML = html;
  }

  function _getGroupAndDescendants(gid) {
    var result = {};
    function _walk(id) {
      result[id] = true;
      var g = _groupMap[id];
      if (g && g.children) g.children.forEach(function(cid) { _walk(cid); });
    }
    _walk(gid);
    return result;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────────

  function switchTab(tab) {
    _activeTab = tab;

    // Update tab button styles
    var tabDaily   = document.getElementById('tabDaily');
    var tabMonthly = document.getElementById('tabMonthly');
    if (tabDaily)   tabDaily.className   = 'ldc-tab' + (tab === 'daily'   ? ' active' : '');
    if (tabMonthly) tabMonthly.className = 'ldc-tab' + (tab === 'monthly' ? ' active' : '');

    // Swap the date/month input in the header
    var wrapper = document.getElementById('dateControlWrapper');
    if (wrapper) {
      if (tab === 'daily') {
        var t    = new Date();
        var yyyy = t.getUTCFullYear();
        var mm   = String(t.getUTCMonth() + 1).padStart(2, '0');
        var dd   = String(t.getUTCDate()).padStart(2, '0');
        wrapper.innerHTML = '<span class="ldc-date-label">Date</span>'
          + '<input type="date" class="ldc-date-input" id="reportDate" value="' + yyyy + '-' + mm + '-' + dd + '">';
      } else {
        var tm   = new Date();
        var ymm  = tm.getUTCFullYear() + '-' + String(tm.getUTCMonth() + 1).padStart(2, '0');
        wrapper.innerHTML = '<span class="ldc-date-label">Month</span>'
          + '<input type="month" class="ldc-date-input" id="reportMonth" value="' + ymm + '">';
      }
    }

    // Update subtitle
    var sub = document.getElementById('ldcSub');
    if (sub) sub.textContent = tab === 'daily' ? 'Daily inspection tracking' : 'Monthly compliance summary';

    // Show/hide the chart section
    var chartSection = document.getElementById('monthlyChart');
    if (chartSection) chartSection.style.display = tab === 'monthly' ? 'block' : 'none';

    // Reset the UI to a clean state — don't auto-run
    _resetToIdle();
  }

  function _resetToIdle() {
    ['cCompliant', 'cNot', 'cNone'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = '-';
    });
    ['pCompliant', 'pNot', 'pNone'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    var tc = document.getElementById('tableContainer');
    if (tc) tc.innerHTML = '<div class="ldc-state-box"><p>Run the report to see results</p></div>';
    var pg = document.getElementById('pagination');
    if (pg) pg.style.display = 'none';
    var cc = document.getElementById('chartContainer');
    if (cc) cc.innerHTML = '';
    var tm = document.getElementById('tableMeta');
    if (tm) tm.textContent = 'Run a report to see results';
    _resetBtn();
  }

  // ── Shared run entry point ────────────────────────────────────────────────────

  function run() {
    // Branch to monthly if that tab is active
    if (_activeTab === 'monthly') { _runMonthly(); return; }

    // ── Daily report ──────────────────────────────────────────────────────────
    var dv = document.getElementById('reportDate') && document.getElementById('reportDate').value;
    if (!dv) { _showError('Please select a date.'); return; }

    _setLoading();

    var from = dv + 'T00:00:00.000Z';
    var to   = dv + 'T23:59:59.999Z';

    _api.multiCall([
      ['Get', { typeName: 'Trip',    search: { fromDate: from, toDate: to } }],
      ['Get', { typeName: 'DVIRLog', search: { fromDate: from, toDate: to } }],
      ['Get', { typeName: 'Device',  search: {} }],
      ['Get', { typeName: 'Group',   search: {} }]
    ], function(results) {
      _process(results);
    }, function(e) {
      _showError('API error: ' + (e && e.message ? e.message : String(e)));
    });
  }

  // ── Daily processing ──────────────────────────────────────────────────────────

  function _process(results) {
    var trips   = (results && results[0]) || [];
    var dvirs   = (results && results[1]) || [];
    var devices = (results && results[2]) || [];
    var groups  = (results && results[3]) || [];

    var gm = {};
    groups.forEach(function(g) {
      gm[g.id] = { name: g.name || g.id, parent: g.parent && g.parent.id };
    });

    var dm = _buildDeviceMap(devices, gm);

    // Sum distance per device (meters)
    var dist = {};
    trips.forEach(function(t) {
      var did = t.device && t.device.id;
      if (!did) return;
      dist[did] = (dist[did] || 0) + ((typeof t.distance === 'number') ? t.distance : 0);
    });

    // Count DVIR logs per device
    var insp = {};
    dvirs.forEach(function(l) {
      var did = l.device && l.device.id;
      if (!did) return;
      insp[did] = (insp[did] || 0) + 1;
    });

    var ids = {};
    Object.keys(dist).forEach(function(k) { ids[k] = true; });
    Object.keys(insp).forEach(function(k) { ids[k] = true; });
    Object.keys(dm).forEach(function(k)   { ids[k] = true; });

    var thresholdMi = _getThreshold();
    var thresholdKm = thresholdMi * 1.60934;

    var rows = [];
    Object.keys(ids).forEach(function(did) {
      var dev     = dm[did] || { name: did, groupName: '', rawGroupId: '', allGroupIds: [] };
      var distM   = dist[did] || 0;
      var inspCnt = insp[did] || 0;
      var moved   = distM > thresholdKm;
      var status  = !moved ? 'noinspection' : (inspCnt > 0 ? 'compliant' : 'notcompliant');

      rows.push({
        deviceId:    did,
        vehicleName: dev.name,
        groupName:   dev.groupName,
        rawGroupId:  dev.rawGroupId,
        allGroupIds: dev.allGroupIds || [],
        status:      status,
        inspCnt:     inspCnt,
        moved:       moved,
        distDisplay: _fmt(distM)
      });
    });

    rows = _filterByGroup(rows);

    var ord = { notcompliant: 0, compliant: 1, noinspection: 2 };
    rows.sort(function(a, b) {
      return (ord[a.status] - ord[b.status]) || a.vehicleName.localeCompare(b.vehicleName);
    });

    _allRows      = rows;
    _activeFilter = 'all';
    _page         = 1;
    _updateSummary();
    _setFilterBtn('fa');
    _applyFilter();
    _resetBtn();
  }

  // ── Monthly run & processing ──────────────────────────────────────────────────

  function _runMonthly() {
    var ymEl = document.getElementById('reportMonth');
    var ym   = ymEl ? ymEl.value : '';
    if (!ym) { _showError('Please select a month.'); return; }

    _setLoading();

    var parts = ym.split('-');
    var yyyy  = parseInt(parts[0], 10);
    var mm    = parseInt(parts[1], 10);  // 1-based
    var last  = _lastDayOfMonth(yyyy, mm);

    var from = ym + '-01T00:00:00.000Z';
    var to   = ym + '-' + String(last).padStart(2, '0') + 'T23:59:59.999Z';

    _api.multiCall([
      ['Get', { typeName: 'Trip',    search: { fromDate: from, toDate: to } }],
      ['Get', { typeName: 'DVIRLog', search: { fromDate: from, toDate: to } }],
      ['Get', { typeName: 'Device',  search: {} }],
      ['Get', { typeName: 'Group',   search: {} }]
    ], function(results) {
      _processMonthly(results, yyyy, mm, last);
    }, function(e) {
      _showError('API error: ' + (e && e.message ? e.message : String(e)));
    });
  }

  function _processMonthly(results, yyyy, mm, lastDay) {
    var trips   = (results && results[0]) || [];
    var dvirs   = (results && results[1]) || [];
    var devices = (results && results[2]) || [];
    var groups  = (results && results[3]) || [];

    var gm = {};
    groups.forEach(function(g) {
      gm[g.id] = { name: g.name || g.id, parent: g.parent && g.parent.id };
    });

    var dm = _buildDeviceMap(devices, gm);

    // Build all calendar day strings for this month: ['YYYY-MM-01', ..., 'YYYY-MM-DD']
    var allDays = [];
    for (var d = 1; d <= lastDay; d++) {
      allDays.push(yyyy + '-' + String(mm).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    }

    // Bucket trip distance by device + day
    // Trip.start field gives the timestamp; substring(0,10) gives YYYY-MM-DD
    var distByDeviceDay = {};  // did -> { dayStr -> distanceKm }
    trips.forEach(function(t) {
      var did = t.device && t.device.id;
      if (!did || !t.start) return;
      var dayStr = t.start.substring(0, 10);
      var km     = (typeof t.distance === 'number') ? t.distance : 0;
      if (!distByDeviceDay[did]) distByDeviceDay[did] = {};
      distByDeviceDay[did][dayStr] = (distByDeviceDay[did][dayStr] || 0) + km;
    });

    // Bucket DVIR inspections by device + day
    // DVIRLog.dateTime gives the timestamp
    var inspByDeviceDay = {};  // did -> { dayStr -> count }
    dvirs.forEach(function(l) {
      var did = l.device && l.device.id;
      if (!did || !l.dateTime) return;
      var dayStr = l.dateTime.substring(0, 10);
      if (!inspByDeviceDay[did]) inspByDeviceDay[did] = {};
      inspByDeviceDay[did][dayStr] = (inspByDeviceDay[did][dayStr] || 0) + 1;
    });

    var thresholdMi = _getThreshold();
    var thresholdKm = thresholdMi * 1.60934;

    // Fleet-level daily totals for the chart
    // Initialise one entry per day
    var dayTotals = {};
    allDays.forEach(function(day) {
      dayTotals[day] = { compliant: 0, notcompliant: 0, noinspection: 0 };
    });

    // Aggregate per vehicle across all days
    var rows = [];
    Object.keys(dm).forEach(function(did) {
      var dev        = dm[did];
      var compDays   = 0;
      var notcDays   = 0;
      var noiDays    = 0;
      var totalInsp  = 0;
      var totalDistM = 0;
      var dayStatuses = [];  // one status string per calendar day, in order

      allDays.forEach(function(day) {
        var distKm  = (distByDeviceDay[did] && distByDeviceDay[did][day]) || 0;
        var inspCnt = (inspByDeviceDay[did] && inspByDeviceDay[did][day]) || 0;
        var moved   = distKm > thresholdKm;
        var status  = !moved ? 'noinspection' : (inspCnt > 0 ? 'compliant' : 'notcompliant');

        dayStatuses.push(status);
        totalDistM += distKm;
        totalInsp  += inspCnt;

        if (status === 'compliant')     { compDays++;  dayTotals[day].compliant++;     }
        else if (status === 'notcompliant') { notcDays++; dayTotals[day].notcompliant++;  }
        else                            { noiDays++;   dayTotals[day].noinspection++;  }
      });

      rows.push({
        deviceId:    did,
        vehicleName: dev.name,
        groupName:   dev.groupName,
        rawGroupId:  dev.rawGroupId,
        allGroupIds: dev.allGroupIds || [],
        compDays:    compDays,
        notcDays:    notcDays,
        noiDays:     noiDays,
        totalInsp:   totalInsp,
        totalDistM:  totalDistM,
        dayStatuses: dayStatuses,
        numDays:     allDays.length
      });
    });

    // Apply group filter
    rows = _filterByGroup(rows);

    // Sort: most not-compliant days first, then alphabetical
    rows.sort(function(a, b) {
      return (b.notcDays - a.notcDays) || a.vehicleName.localeCompare(b.vehicleName);
    });

    // Store fleet day totals as ordered array for the chart
    _mDayTotals = allDays.map(function(day) {
      return {
        day:          day,
        compliant:    dayTotals[day].compliant,
        notcompliant: dayTotals[day].notcompliant,
        noinspection: dayTotals[day].noinspection
      };
    });

    _mAllRows      = rows;
    _mActiveFilter = 'all';
    _mPage         = 1;

    _updateSummaryMonthly(yyyy, mm);
    _renderChart(yyyy, mm);
    _mSetFilterBtn('fa');
    _mApplyFilter();
    _resetBtn();
  }

  // ── Monthly summary cards ─────────────────────────────────────────────────────

  function _updateSummaryMonthly(yyyy, mm) {
    var totalComp = 0, totalNotc = 0, totalNoi = 0;
    _mAllRows.forEach(function(r) {
      totalComp += r.compDays;
      totalNotc += r.notcDays;
      totalNoi  += r.noiDays;
    });

    var totalVehicleDays = totalComp + totalNotc + totalNoi;
    var vCount           = _mAllRows.length;
    var label            = _monthLabel(yyyy + '-' + String(mm).padStart(2, '0'));

    document.getElementById('cCompliant').textContent = totalComp;
    document.getElementById('cNot').textContent       = totalNotc;
    document.getElementById('cNone').textContent      = totalNoi;

    document.getElementById('pCompliant').textContent = totalVehicleDays
      ? Math.round(totalComp / totalVehicleDays * 100) + '% of vehicle-days · ' + vCount + ' vehicles'
      : '';
    document.getElementById('pNot').textContent = totalVehicleDays
      ? Math.round(totalNotc / totalVehicleDays * 100) + '% of vehicle-days · ' + vCount + ' vehicles'
      : '';
    document.getElementById('pNone').textContent = totalVehicleDays
      ? Math.round(totalNoi  / totalVehicleDays * 100) + '% of vehicle-days · ' + vCount + ' vehicles'
      : '';
  }

  // ── Fleet bar chart (pure SVG) ────────────────────────────────────────────────

  function _renderChart(yyyy, mm) {
    var container = document.getElementById('chartContainer');
    if (!container || !_mDayTotals.length) return;

    var W         = container.offsetWidth || 600;
    var H         = 150;
    var padL      = 28;   // left axis
    var padR      = 8;
    var padT      = 8;
    var padB      = 20;   // x-axis labels
    var chartW    = W - padL - padR;
    var chartH    = H - padT - padB;
    var numDays   = _mDayTotals.length;
    var barW      = Math.max(2, Math.floor(chartW / numDays) - 1);
    var gap       = Math.floor(chartW / numDays) - barW;

    // Max vehicles per day (for y-scale)
    var maxV = 0;
    _mDayTotals.forEach(function(d) {
      var total = d.compliant + d.notcompliant + d.noinspection;
      if (total > maxV) maxV = total;
    });
    if (maxV === 0) maxV = 1;

    // Y-axis grid lines at 0, 25%, 50%, 75%, 100%
    var gridLines = [0, 0.25, 0.5, 0.75, 1];

    var svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" '
            + 'role="img" aria-label="Stacked bar chart of daily fleet DVIR compliance">';

    // Grid lines + y-axis labels
    gridLines.forEach(function(pct) {
      var y = padT + chartH - Math.round(pct * chartH);
      var label = Math.round(pct * maxV);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" '
           + 'stroke="#98A4AE" stroke-opacity="0.15" stroke-width="1"/>';
      svg += '<text x="' + (padL - 4) + '" y="' + (y + 4) + '" '
           + 'text-anchor="end" font-size="9" font-family="Arial" fill="#98A4AE">' + label + '</text>';
    });

    // Bars
    _mDayTotals.forEach(function(d, i) {
      var total    = d.compliant + d.notcompliant + d.noinspection;
      var x        = padL + i * (barW + gap);
      var yBase    = padT + chartH;

      // Stack order bottom to top: compliant (green), notcompliant (red), noinspection (blue)
      var hComp = total > 0 ? Math.round(d.compliant    / maxV * chartH) : 0;
      var hNotc = total > 0 ? Math.round(d.notcompliant / maxV * chartH) : 0;
      var hNoi  = total > 0 ? Math.round(d.noinspection / maxV * chartH) : 0;

      // Tooltip text with percentages
      var pComp = total > 0 ? Math.round(d.compliant    / total * 100) : 0;
      var pNotc = total > 0 ? Math.round(d.notcompliant / total * 100) : 0;
      var pNoi  = total > 0 ? Math.round(d.noinspection / total * 100) : 0;
      var dayNum = i + 1;
      var dowStr = _dowName(d.day);
      var tipText = _esc('Apr ' + dayNum + ' (' + dowStr + ')'
        + ' · ' + d.compliant    + ' compliant ('    + pComp + '%)'
        + ' · ' + d.notcompliant + ' not compliant (' + pNotc + '%)'
        + ' · ' + d.noinspection + ' no insp. needed (' + pNoi  + '%)');

      svg += '<g><title>' + tipText + '</title>';

      if (hComp > 0) {
        svg += '<rect x="' + x + '" y="' + (yBase - hComp) + '" '
             + 'width="' + barW + '" height="' + hComp + '" fill="#84BD00"/>';
      }
      if (hNotc > 0) {
        svg += '<rect x="' + x + '" y="' + (yBase - hComp - hNotc) + '" '
             + 'width="' + barW + '" height="' + hNotc + '" fill="#CF4520"/>';
      }
      if (hNoi > 0) {
        svg += '<rect x="' + x + '" y="' + (yBase - hComp - hNotc - hNoi) + '" '
             + 'width="' + barW + '" height="' + hNoi + '" fill="#3D76BF"/>';
      }

      svg += '</g>';

      // X-axis labels: day 1, every 7th, and last day
      if (dayNum === 1 || dayNum % 7 === 0 || dayNum === numDays) {
        svg += '<text x="' + (x + barW / 2) + '" y="' + (H - 4) + '" '
             + 'text-anchor="middle" font-size="9" font-family="Arial" fill="#98A4AE">' + dayNum + '</text>';
      }
    });

    svg += '</svg>';
    container.innerHTML = svg;
  }

  // ── Monthly filter ────────────────────────────────────────────────────────────

  function _mApplyFilter() {
    if (_mActiveFilter === 'all') {
      _mFilteredRows = _mAllRows.slice();
    } else if (_mActiveFilter === 'compliant') {
      _mFilteredRows = _mAllRows.filter(function(r) { return r.compDays > 0; });
    } else if (_mActiveFilter === 'notcompliant') {
      _mFilteredRows = _mAllRows.filter(function(r) { return r.notcDays > 0; });
    } else if (_mActiveFilter === 'noinspection') {
      _mFilteredRows = _mAllRows.filter(function(r) { return r.noiDays > 0; });
    }
    _renderMonthlyTable();
  }

  function _mSetFilterBtn(activeId) {
    ['fa', 'fc', 'fn', 'fni'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.className = 'ldc-filter-btn' + (id === activeId ? ' active' : '');
    });
  }

  // ── Monthly table ─────────────────────────────────────────────────────────────

  function _renderMonthlyTable() {
    var container  = document.getElementById('tableContainer');
    var pagination = document.getElementById('pagination');

    if (!_mFilteredRows.length) {
      container.innerHTML = '<div class="ldc-state-box"><p>No vehicles match this filter</p></div>';
      if (pagination) pagination.style.display = 'none';
      document.getElementById('tableMeta').textContent =
        _mAllRows.length + ' vehicle' + (_mAllRows.length !== 1 ? 's' : '') + ' total';
      return;
    }

    var totalPages = Math.ceil(_mFilteredRows.length / _pageSize);
    if (_mPage > totalPages) _mPage = totalPages;
    var start    = (_mPage - 1) * _pageSize;
    var end      = Math.min(start + _pageSize, _mFilteredRows.length);
    var pageRows = _mFilteredRows.slice(start, end);

    var html = '<table class="ldc-table"><thead><tr>'
      + '<th>Vehicle</th>'
      + '<th>Group</th>'
      + '<th>Month compliance</th>'
      + '<th style="text-align:center">Compliant<br>days</th>'
      + '<th style="text-align:center">Not compliant<br>days</th>'
      + '<th style="text-align:center">No insp.<br>needed</th>'
      + '<th style="text-align:center">Inspections<br>submitted</th>'
      + '<th style="text-align:right">Total<br>distance</th>'
      + '</tr></thead><tbody>';

    pageRows.forEach(function(r) {
      var numDays = r.numDays;
      // Dot strip: one circle per calendar day
      // Width: 3 (left pad) + numDays * 5 (spacing) + 2 (right pad)
      var stripW = 3 + numDays * 5 + 2;
      var dots = '';
      r.dayStatuses.forEach(function(status, i) {
        var fill = status === 'compliant'     ? '#84BD00'
                 : status === 'notcompliant'  ? '#CF4520'
                 :                             '#3D76BF';
        var cx = 3 + i * 5;
        dots += '<circle cx="' + cx + '" cy="7" r="2.5" fill="' + fill + '"/>';
      });
      var stripSvg = '<svg width="' + stripW + '" height="14" style="display:block" aria-hidden="true">'
                   + dots + '</svg>';

      // Compliance day colours
      var compColor = r.compDays > 0  ? '#84BD00' : '#98A4AE';
      var notcColor = r.notcDays > 0  ? '#CF4520' : '#98A4AE';
      var noiColor  = '#98A4AE';
      var inspColor = r.totalInsp > 0 ? '#009CDE' : '#98A4AE';

      html += '<tr>'
        + '<td style="font-weight:600">' + _esc(r.vehicleName) + '</td>'
        + '<td style="color:#98A4AE;font-size:12px">' + _esc(r.groupName || '-') + '</td>'
        + '<td>' + stripSvg + '</td>'
        + '<td style="text-align:center;color:' + compColor + ';font-weight:700;font-size:13px">' + r.compDays + '</td>'
        + '<td style="text-align:center;color:' + notcColor + ';font-weight:700;font-size:13px">' + r.notcDays + '</td>'
        + '<td style="text-align:center;color:' + noiColor  + ';font-weight:700;font-size:13px">' + r.noiDays  + '</td>'
        + '<td style="text-align:center;color:' + inspColor + ';font-weight:700;font-size:13px">' + r.totalInsp + '</td>'
        + '<td style="text-align:right;color:#98A4AE;font-size:12px">' + _esc(_fmt(r.totalDistM)) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    var fl = _mActiveFilter !== 'all' ? ' (filtered)' : '';
    document.getElementById('tableMeta').textContent =
      _mFilteredRows.length + ' vehicle' + (_mFilteredRows.length !== 1 ? 's' : '')
      + fl + ' — ' + _mAllRows.length + ' total';

    if (pagination) {
      pagination.style.display = 'flex';
      document.getElementById('pageInfo').textContent =
        'Page ' + _mPage + ' of ' + Math.max(1, totalPages)
        + ' — ' + (start + 1) + '–' + end + ' of ' + _mFilteredRows.length;
      document.getElementById('prevBtn').disabled = _mPage <= 1;
      document.getElementById('nextBtn').disabled = _mPage >= totalPages;
    }
  }

  // ── Daily summary cards ───────────────────────────────────────────────────────

  function _updateSummary() {
    var c  = _allRows.filter(function(r) { return r.status === 'compliant';    }).length;
    var n  = _allRows.filter(function(r) { return r.status === 'notcompliant'; }).length;
    var ni = _allRows.filter(function(r) { return r.status === 'noinspection'; }).length;
    var total = _allRows.length;
    document.getElementById('cCompliant').textContent = c;
    document.getElementById('cNot').textContent       = n;
    document.getElementById('cNone').textContent      = ni;
    document.getElementById('pCompliant').textContent = total ? Math.round(c  / total * 100) + '% of fleet' : '';
    document.getElementById('pNot').textContent       = total ? Math.round(n  / total * 100) + '% of fleet' : '';
    document.getElementById('pNone').textContent      = total ? Math.round(ni / total * 100) + '% of fleet' : '';
  }

  // ── Daily filter ──────────────────────────────────────────────────────────────

  function filter(f) {
    _activeFilter = f;
    _page = 1;
    var m = { all: 'fa', compliant: 'fc', notcompliant: 'fn', noinspection: 'fni' };
    _setFilterBtn(m[f]);
    _applyFilter();
  }

  function _setFilterBtn(activeId) {
    ['fa', 'fc', 'fn', 'fni'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.className = 'ldc-filter-btn' + (id === activeId ? ' active' : '');
    });
  }

  function _applyFilter() {
    _filteredRows = _activeFilter === 'all'
      ? _allRows.slice()
      : _allRows.filter(function(r) { return r.status === _activeFilter; });
    _renderTable();
  }

  // ── Unified filter dispatcher ─────────────────────────────────────────────────
  // Called by filter buttons in index.html — routes to daily or monthly

  function filterAny(f) {
    if (_activeTab === 'monthly') {
      _mActiveFilter = f;
      _mPage = 1;
      var mm = { all: 'fa', compliant: 'fc', notcompliant: 'fn', noinspection: 'fni' };
      _mSetFilterBtn(mm[f]);
      _mApplyFilter();
    } else {
      filter(f);
    }
  }

  // ── Daily table ───────────────────────────────────────────────────────────────

  function _renderTable() {
    var container  = document.getElementById('tableContainer');
    var pagination = document.getElementById('pagination');

    if (!_filteredRows.length) {
      container.innerHTML = '<div class="ldc-state-box"><p>No vehicles match this filter</p></div>';
      if (pagination) pagination.style.display = 'none';
      document.getElementById('tableMeta').textContent =
        _allRows.length + ' vehicle' + (_allRows.length !== 1 ? 's' : '') + ' total';
      return;
    }

    var totalPages = Math.ceil(_filteredRows.length / _pageSize);
    if (_page > totalPages) _page = totalPages;
    var start    = (_page - 1) * _pageSize;
    var end      = Math.min(start + _pageSize, _filteredRows.length);
    var pageRows = _filteredRows.slice(start, end);

    var html = '<table class="ldc-table"><thead><tr>'
      + '<th>Vehicle</th><th>Group</th><th>Compliance</th>'
      + '<th>Inspected</th><th>Inspections</th><th>Vehicle Moved</th><th>Distance</th>'
      + '</tr></thead><tbody>';

    pageRows.forEach(function(r) {
      var bc, label;
      if (r.status === 'compliant')         { bc = 'ldc-badge-green'; label = 'Compliant'; }
      else if (r.status === 'notcompliant') { bc = 'ldc-badge-red';   label = 'Not Compliant'; }
      else                                  { bc = 'ldc-badge-grey';  label = 'No Inspection Needed'; }

      var inspColor = r.inspCnt > 0 ? '#009CDE' : '#98A4AE';
      var moveColor = r.moved   ? '#FFFFFF'   : '#98A4AE';

      html += '<tr>'
        + '<td style="font-weight:600">' + _esc(r.vehicleName) + '</td>'
        + '<td style="color:#98A4AE;font-size:12px">' + _esc(r.groupName || '-') + '</td>'
        + '<td><span class="ldc-badge ' + bc + '">' + label + '</span></td>'
        + '<td style="color:' + moveColor + ';font-size:12px">' + (r.inspCnt > 0 ? 'Inspected' : 'Not Inspected') + '</td>'
        + '<td style="color:' + inspColor + ';font-size:12px;font-weight:600">' + r.inspCnt + '</td>'
        + '<td style="color:' + moveColor + ';font-size:12px">' + (r.moved ? 'Vehicle Moved' : 'Did Not Move') + '</td>'
        + '<td style="color:' + moveColor + ';font-size:12px">' + _esc(r.distDisplay) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    var fl = _activeFilter !== 'all' ? ' (filtered)' : '';
    document.getElementById('tableMeta').textContent =
      _filteredRows.length + ' vehicle' + (_filteredRows.length !== 1 ? 's' : '')
      + fl + ' - ' + _allRows.length + ' total';

    if (pagination) {
      pagination.style.display = 'flex';
      document.getElementById('pageInfo').textContent =
        'Page ' + _page + ' of ' + Math.max(1, totalPages)
        + ' - ' + (start + 1) + '-' + end + ' of ' + _filteredRows.length;
      document.getElementById('prevBtn').disabled = _page <= 1;
      document.getElementById('nextBtn').disabled = _page >= totalPages;
    }
  }

  // ── Pagination ────────────────────────────────────────────────────────────────

  function prevPage() {
    if (_activeTab === 'monthly') {
      if (_mPage > 1) { _mPage--; _renderMonthlyTable(); }
      return;
    }
    if (_page > 1) { _page--; _renderTable(); }
  }

  function nextPage() {
    if (_activeTab === 'monthly') {
      if (_mPage < Math.ceil(_mFilteredRows.length / _pageSize)) { _mPage++; _renderMonthlyTable(); }
      return;
    }
    if (_page < Math.ceil(_filteredRows.length / _pageSize)) { _page++; _renderTable(); }
  }

  // ── CSV export ────────────────────────────────────────────────────────────────

  function exportCSV() {
    if (_activeTab === 'monthly') { _exportCSVMonthly(); return; }

    if (!_allRows.length) return;
    var dv    = document.getElementById('reportDate') && document.getElementById('reportDate').value;
    var lines = ['Date,Vehicle Name,Group,Compliance Status,Inspected,Inspections Submitted,Vehicle Moved,Distance'];
    _allRows.forEach(function(r) {
      var lb = r.status === 'compliant' ? 'Compliant'
             : r.status === 'notcompliant' ? 'Not Compliant'
             : 'No Inspection Needed';
      lines.push([
        dv, r.vehicleName, r.groupName || '', lb,
        r.inspCnt > 0 ? 'Inspected' : 'Not Inspected',
        r.inspCnt,
        r.moved ? 'Vehicle Moved' : 'Vehicle Did Not Move',
        r.distDisplay
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    _downloadCSV(lines, 'lytx-dvir-compliance-' + dv + '.csv');
  }

  function _exportCSVMonthly() {
    if (!_mAllRows.length) return;
    var ym    = document.getElementById('reportMonth') && document.getElementById('reportMonth').value;
    var lines = ['Month,Vehicle Name,Group,Compliant Days,Not Compliant Days,No Inspection Days,Inspections Submitted,Total Distance'];
    _mAllRows.forEach(function(r) {
      lines.push([
        ym, r.vehicleName, r.groupName || '',
        r.compDays, r.notcDays, r.noiDays,
        r.totalInsp, _fmt(r.totalDistM)
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    _downloadCSV(lines, 'lytx-dvir-compliance-monthly-' + ym + '.csv');
  }

  function _downloadCSV(lines, filename) {
    var blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href   = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Shared device map builder ─────────────────────────────────────────────────
  // Extracted from _process() so both daily and monthly use identical filtering

  function _buildDeviceMap(devices, gm) {
    var dm = {};
    devices.forEach(function(d) {
      // Skip archived/deactivated
      if (d.activeTo && new Date(d.activeTo) < new Date()) return;

      // Skip non-vehicles (trailers, untagged assets)
      var isVehicle = false;
      if (d.groups) {
        d.groups.forEach(function(dg) { if (dg.id === 'GroupVehicleId') isVehicle = true; });
      }
      if (!isVehicle) return;

      // Pick first non-builtin group for display
      var chosen = null;
      var gn     = '';
      if (d.groups) {
        for (var i = 0; i < d.groups.length; i++) {
          if (!_isBuiltinGroup(d.groups[i].id)) { chosen = d.groups[i].id; break; }
        }
      }
      if (chosen) gn = (gm[chosen] && gm[chosen].name) || chosen;

      var allGroupIds = [];
      if (d.groups) {
        d.groups.forEach(function(dg) {
          if (!_isBuiltinGroup(dg.id)) allGroupIds.push(dg.id);
        });
      }

      dm[d.id] = { name: d.name || d.id, groupName: gn, rawGroupId: chosen || '', allGroupIds: allGroupIds };
    });
    return dm;
  }

  // ── Shared group filter ───────────────────────────────────────────────────────

  function _filterByGroup(rows) {
    if (!_selectedGroupId || !Object.keys(_groupMap).length) return rows;
    var allowed = _getGroupAndDescendants(_selectedGroupId);
    return rows.filter(function(r) {
      if (!r.allGroupIds || !r.allGroupIds.length) return true;
      for (var i = 0; i < r.allGroupIds.length; i++) {
        if (allowed[r.allGroupIds[i]]) return true;
      }
      return false;
    });
  }

  // ── Shared threshold reader ───────────────────────────────────────────────────

  function _getThreshold() {
    var el = document.getElementById('distanceThreshold');
    return el ? parseFloat(el.value) || 0 : 2;
  }

  // ── Loading / error states ────────────────────────────────────────────────────

  function _setLoading() {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box"><p>Loading data...</p></div>';
    var pag = document.getElementById('pagination');
    if (pag) pag.style.display = 'none';
    var cc = document.getElementById('chartContainer');
    if (cc) cc.innerHTML = '';
    ['cCompliant', 'cNot', 'cNone'].forEach(function(id) {
      document.getElementById(id).textContent = '-';
    });
    ['pCompliant', 'pNot', 'pNone'].forEach(function(id) {
      document.getElementById(id).textContent = '';
    });
    document.getElementById('tableMeta').textContent = 'Loading...';
    document.getElementById('runBtn').disabled = true;
  }

  function _resetBtn() {
    var btn = document.getElementById('runBtn');
    if (!btn) return;
    btn.disabled    = false;
    btn.textContent = 'Run Report';
  }

  function _showError(msg) {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box" style="color:#CF4520"><p>' + _esc(msg) + '</p></div>';
    _resetBtn();
  }

  // ── Group panel ───────────────────────────────────────────────────────────────

  function groupNav(gid) {
    _navGroupId      = gid;
    _selectedGroupId = gid;
    var g   = _groupMap[gid];
    var lbl = document.getElementById('groupFilterLabel');
    if (lbl) lbl.textContent = g ? g.name : 'All Groups';
    _renderGroupPanel();
  }

  function groupSelect(gid) {
    _selectedGroupId = gid;
    _navGroupId      = gid;
    var g   = _groupMap[gid];
    var lbl = document.getElementById('groupFilterLabel');
    if (lbl) lbl.textContent = g ? g.name : 'All Groups';
    _renderGroupPanel();
  }

  function toggleGroupPanel() {
    var panel = document.getElementById('groupPanel');
    if (!panel) return;
    if (panel.style.display === 'none' || panel.style.display === '') {
      _navGroupId = _selectedGroupId;
      _renderGroupPanel();
      panel.style.display = 'block';
      setTimeout(function() {
        document.addEventListener('click', _outsideClickHandler);
      }, 0);
    } else {
      panel.style.display = 'none';
      document.removeEventListener('click', _outsideClickHandler);
    }
  }

  function _outsideClickHandler(e) {
    var panel = document.getElementById('groupPanel');
    var btn   = document.getElementById('groupFilterBtn');
    if (!panel) return;
    if ((panel && panel.contains(e.target)) || (btn && btn.contains(e.target))) return;
    panel.style.display = 'none';
    document.removeEventListener('click', _outsideClickHandler);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return {
    init:             init,
    run:              run,
    switchTab:        switchTab,
    filter:           filter,
    filterAny:        filterAny,
    prevPage:         prevPage,
    nextPage:         nextPage,
    exportCSV:        exportCSV,
    groupNav:         groupNav,
    groupSelect:      groupSelect,
    toggleGroupPanel: toggleGroupPanel
  };

}());
