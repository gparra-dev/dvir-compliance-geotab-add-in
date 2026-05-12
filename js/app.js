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

  // -- Shared state -------------------------------------------------------------
  var _api             = null;
  var _state           = null;
  var _isMetric        = true;
  var _groupMap        = {};
  var _selectedGroupId = null;
  var _navGroupId      = null;

  // -- Daily state --------------------------------------------------------------
  var _allRows      = [];
  var _filteredRows = [];
  var _activeFilter = 'all';
  var _page         = 1;
  var _pageSize     = 50;

  // -- Monthly state ------------------------------------------------------------
  var _activeTab     = 'daily';
  var _mAllRows      = [];
  var _mFilteredRows = [];
  var _mActiveFilter = 'all';
  var _mPage         = 1;
  var _mDayTotals    = [];

  // -- Helpers ------------------------------------------------------------------

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

  function _lastDayOfMonth(yyyy, mm) {
    return new Date(yyyy, mm, 0).getDate();
  }

  function _dowName(dateStr) {
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var d = new Date(dateStr + 'T12:00:00Z');
    return days[d.getUTCDay()];
  }

  function _monthLabel(ym) {
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var parts = ym.split('-');
    return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }

  // Returns today as YYYY-MM-DD in UTC
  function _todayUTC() {
    var n = new Date();
    return n.getUTCFullYear() + '-'
      + String(n.getUTCMonth() + 1).padStart(2, '0') + '-'
      + String(n.getUTCDate()).padStart(2, '0');
  }

  // -- Initialisation -----------------------------------------------------------

  function init(api, state) {
    _api   = api;
    _state = state;
    var t    = new Date();
    var yyyy = t.getUTCFullYear();
    var mm   = String(t.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(t.getUTCDate()).padStart(2, '0');
    var dateEl = document.getElementById('reportDate');
    if (dateEl) dateEl.value = yyyy + '-' + mm + '-' + dd;

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

  // -- Group tree ---------------------------------------------------------------

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
        var cg      = _groupMap[cid];
        var hasKids = cg.children && cg.children.filter(function(k) { return !_isBuiltinGroup(k); }).length > 0;
        var cSel    = (cid === _selectedGroupId);
        html += '<div class="gp-item' + (cSel ? ' gp-selected' : '') + '" onclick="DVIRApp.groupNav(\'' + cid + '\')">'
              + '<span>' + (cSel ? '&#10003; ' : '') + _esc(cg.name) + '</span>'
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

  // -- Tab switching ------------------------------------------------------------

  function switchTab(tab) {
    _activeTab = tab;

    var tabDaily   = document.getElementById('tabDaily');
    var tabMonthly = document.getElementById('tabMonthly');
    if (tabDaily)   tabDaily.className   = 'ldc-tab' + (tab === 'daily'   ? ' active' : '');
    if (tabMonthly) tabMonthly.className = 'ldc-tab' + (tab === 'monthly' ? ' active' : '');

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
        var tm  = new Date();
        var ymm = tm.getUTCFullYear() + '-' + String(tm.getUTCMonth() + 1).padStart(2, '0');
        wrapper.innerHTML = '<span class="ldc-date-label">Month</span>'
          + '<input type="month" class="ldc-date-input" id="reportMonth" value="' + ymm + '">';
      }
    }

    var sub = document.getElementById('ldcSub');
    if (sub) sub.textContent = tab === 'daily' ? 'Daily inspection tracking' : 'Monthly compliance summary';

    var chartSection = document.getElementById('monthlyChart');
    if (chartSection) chartSection.style.display = tab === 'monthly' ? 'block' : 'none';

    // Auto-run when switching tabs
    run();
  }

  function _resetToIdle() {
    ['cCompliant', 'cNot', 'cNone'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.textContent = '-';
    });
    ['pCompliant', 'pNot', 'pNone'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.textContent = '';
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

  // -- Shared run entry point ---------------------------------------------------

  function run() {
    if (_activeTab === 'monthly') { _runMonthly(); return; }

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

  // -- Daily processing ---------------------------------------------------------

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

    var dist = {};
    trips.forEach(function(t) {
      var did = t.device && t.device.id;
      if (!did) return;
      dist[did] = (dist[did] || 0) + ((typeof t.distance === 'number') ? t.distance : 0);
    });

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

    var thresholdKm = _getThreshold() * 1.60934;
    var rows = [];
    Object.keys(ids).forEach(function(did) {
      var dev     = dm[did] || { name: did, groupName: '', rawGroupId: '', allGroupIds: [] };
      var distM   = dist[did] || 0;
      var inspCnt = insp[did] || 0;
      var moved   = distM > thresholdKm;
      var status  = !moved ? 'noinspection' : (inspCnt > 0 ? 'compliant' : 'notcompliant');
      rows.push({
        deviceId: did, vehicleName: dev.name, groupName: dev.groupName,
        rawGroupId: dev.rawGroupId, allGroupIds: dev.allGroupIds || [],
        status: status, inspCnt: inspCnt, moved: moved, distDisplay: _fmt(distM)
      });
    });

    rows = _filterByGroup(rows);
    var ord = { notcompliant: 0, compliant: 1, noinspection: 2 };
    rows.sort(function(a, b) {
      return (ord[a.status] - ord[b.status]) || a.vehicleName.localeCompare(b.vehicleName);
    });

    _allRows = rows; _activeFilter = 'all'; _page = 1;
    _updateSummary(); _setFilterBtn('fa'); _applyFilter(); _resetBtn();
  }

  // -- Monthly run --------------------------------------------------------------

  function _runMonthly() {
    var ymEl = document.getElementById('reportMonth');
    var ym   = ymEl ? ymEl.value : '';
    if (!ym) { _showError('Please select a month.'); return; }

    _setLoading();

    var parts   = ym.split('-');
    var yyyy    = parseInt(parts[0], 10);
    var mm      = parseInt(parts[1], 10);
    var lastDay = _lastDayOfMonth(yyyy, mm);
    var from    = ym + '-01T00:00:00.000Z';
    var to      = ym + '-' + String(lastDay).padStart(2, '0') + 'T23:59:59.999Z';

    // Determine today UTC -- used to black out future days in the current month
    var today          = _todayUTC();
    var isCurrentMonth = (today.substring(0, 7) === ym);
    var lastKnownDay   = isCurrentMonth ? parseInt(today.substring(8, 10), 10) : lastDay;

    // Scope trips and DVIRLogs to the selected group if one is set
    var groupSearch = _selectedGroupId ? [{ id: _selectedGroupId }] : null;
    var dvirSearch  = { fromDate: from, toDate: to };
    if (groupSearch) dvirSearch.deviceSearch = { groups: groupSearch };

    // Step 1 -- fetch DVIRLogs, Devices, Groups in one multiCall
    _api.multiCall([
      ['Get', { typeName: 'DVIRLog', search: dvirSearch }],
      ['Get', { typeName: 'Device',  search: {} }],
      ['Get', { typeName: 'Group',   search: {} }]
    ], function(r1) {
      var dvirs   = r1[0] || [];
      var devices = r1[1] || [];
      var groups  = r1[2] || [];

      // Step 2 -- paginate trips, scoped to selected group
      _setLoadingMessage('Fetching trips -- page 1...');
      _fetchAllTrips(from, to, groupSearch, [], 1, null, null, function(allTrips) {
        _processMonthly(allTrips, dvirs, devices, groups, yyyy, mm, lastDay, lastKnownDay);
      });
    }, function(e) {
      _showError('API error: ' + (e && e.message ? e.message : String(e)));
    });
  }

  // -- Trip pagination ----------------------------------------------------------
  // Sort-based cursor pagination. PropertySelector keeps payloads small.
  // Stops when a page returns fewer than 25,000 records.

  function _fetchAllTrips(from, to, groupSearch, accumulated, pageNum, offsetStart, offsetId, callback) {
    var sortObj = { sortBy: 'start' };
    if (offsetStart) {
      sortObj.offset = offsetStart;
      sortObj.lastId = offsetId;
    }

    // TripSearch does not support group filtering -- Geotab silently ignores
    // deviceSearch.groups on Trip. Fetch all trips for the date range and
    // rely on client-side _filterByGroup for group scoping.
    var tripSearch = { fromDate: from, toDate: to };
    if (groupSearch) tripSearch.deviceSearch = { groups: groupSearch };

    _api.call('Get', {
      typeName: 'Trip',
      search: tripSearch,
      resultsLimit: 25000,
      propertySelector: { fields: ['id', 'device', 'start', 'distance'], isIncluded: true },
      sort: sortObj
    }, function(page) {
      var combined = accumulated.concat(page || []);
      if (pageNum === 1) {
        console.log('[trip debug] search sent:', JSON.stringify(tripSearch));
        console.log('[trip debug] page 1 count:', (page || []).length, '| hit cap?', (page || []).length === 25000);
        if (page && page.length > 0) console.log('[trip debug] page 1 sample device ids:', page.slice(0,5).map(function(t){return t.device&&t.device.id;}).join(','));
      }
      if (!page || page.length < 25000) {
        callback(combined);
      } else {
        var last = page[page.length - 1];
        _setLoadingMessage('Fetching trips -- page ' + (pageNum + 1) + '...');
        _fetchAllTrips(from, to, groupSearch, combined, pageNum + 1, last.start, last.id, callback);
      }
    }, function(e) {
      _showError('API error fetching trips (page ' + pageNum + '): ' + (e && e.message ? e.message : String(e)));
    });
  }

  // -- Monthly processing -------------------------------------------------------

  function _processMonthly(trips, dvirs, devices, groups, yyyy, mm, lastDay, lastKnownDay) {
    var gm = {};
    groups.forEach(function(g) {
      gm[g.id] = { name: g.name || g.id, parent: g.parent && g.parent.id };
    });

    var dm = _buildDeviceMap(devices, gm);

    // Build calendar days -- mark days beyond lastKnownDay as future
    var allDays    = [];
    var futureDays = {};
    var mmStr      = String(mm).padStart(2, '0');
    for (var d = 1; d <= lastDay; d++) {
      var ds = yyyy + '-' + mmStr + '-' + String(d).padStart(2, '0');
      allDays.push(ds);
      if (d > lastKnownDay) futureDays[ds] = true;
    }

    // Bucket trip distance by device + day
    var distByDeviceDay = {};
    trips.forEach(function(t) {
      var did = t.device && t.device.id;
      if (!did || !t.start) return;
      var dayStr = t.start.substring(0, 10);
      var km     = (typeof t.distance === 'number') ? t.distance : 0;
      if (!distByDeviceDay[did]) distByDeviceDay[did] = {};
      distByDeviceDay[did][dayStr] = (distByDeviceDay[did][dayStr] || 0) + km;
    });

    // Bucket DVIR inspections by device + day
    var inspByDeviceDay = {};
    dvirs.forEach(function(l) {
      var did = l.device && l.device.id;
      if (!did || !l.dateTime) return;
      var dayStr = l.dateTime.substring(0, 10);
      if (!inspByDeviceDay[did]) inspByDeviceDay[did] = {};
      inspByDeviceDay[did][dayStr] = (inspByDeviceDay[did][dayStr] || 0) + 1;
    });

    var thresholdKm = _getThreshold() * 1.60934;

    // Aggregate per vehicle across all days
    var rows = [];
    Object.keys(dm).forEach(function(did) {
      var dev         = dm[did];
      var compDays    = 0, notcDays = 0, noiDays = 0;
      var totalInsp   = 0, totalDistM = 0;
      var dayStatuses = [];

      allDays.forEach(function(day) {
        // Future days get a special status -- excluded from compliance counts
        if (futureDays[day]) {
          dayStatuses.push('future');
          return;
        }
        var distKm  = (distByDeviceDay[did] && distByDeviceDay[did][day]) || 0;
        var inspCnt = (inspByDeviceDay[did] && inspByDeviceDay[did][day]) || 0;
        var moved   = distKm > thresholdKm;
        var status  = !moved ? 'noinspection' : (inspCnt > 0 ? 'compliant' : 'notcompliant');

        dayStatuses.push(status);
        totalDistM += distKm;
        totalInsp  += inspCnt;

        if (status === 'compliant')         compDays++;
        else if (status === 'notcompliant') notcDays++;
        else                               noiDays++;
      });

      rows.push({
        deviceId: did, vehicleName: dev.name, groupName: dev.groupName,
        rawGroupId: dev.rawGroupId, allGroupIds: dev.allGroupIds || [],
        compDays: compDays, notcDays: notcDays, noiDays: noiDays,
        totalInsp: totalInsp, totalDistM: totalDistM,
        dayStatuses: dayStatuses, numDays: allDays.length
      });
    });

    rows = _filterByGroup(rows);
    rows.sort(function(a, b) {
      return (b.notcDays - a.notcDays) || a.vehicleName.localeCompare(b.vehicleName);
    });

    // Rebuild day totals from filtered rows only -- skip future days
    var filteredTotals = {};
    allDays.forEach(function(day) {
      filteredTotals[day] = { compliant: 0, notcompliant: 0, noinspection: 0 };
    });
    rows.forEach(function(r) {
      r.dayStatuses.forEach(function(status, i) {
        var day = allDays[i];
        if (status === 'future') return;
        if (status === 'compliant')         filteredTotals[day].compliant++;
        else if (status === 'notcompliant') filteredTotals[day].notcompliant++;
        else                               filteredTotals[day].noinspection++;
      });
    });

    _mDayTotals = allDays.map(function(day) {
      return {
        day:          day,
        compliant:    filteredTotals[day].compliant,
        notcompliant: filteredTotals[day].notcompliant,
        noinspection: filteredTotals[day].noinspection,
        future:       futureDays[day] || false
      };
    });

    _mAllRows = rows; _mActiveFilter = 'all'; _mPage = 1;
    _updateSummaryMonthly(yyyy, mm);
    _renderChart(yyyy, mm);
    _mSetFilterBtn('fa');
    _mApplyFilter();
    _resetBtn();
  }

  // -- Monthly summary cards ----------------------------------------------------

  function _updateSummaryMonthly(yyyy, mm) {
    var totalComp = 0, totalNotc = 0, totalNoi = 0;
    _mAllRows.forEach(function(r) {
      totalComp += r.compDays; totalNotc += r.notcDays; totalNoi += r.noiDays;
    });
    var totalVD = totalComp + totalNotc + totalNoi;
    var vCount  = _mAllRows.length;

    document.getElementById('cCompliant').textContent = totalComp;
    document.getElementById('cNot').textContent       = totalNotc;
    document.getElementById('cNone').textContent      = totalNoi;
    document.getElementById('pCompliant').textContent = totalVD ? Math.round(totalComp / totalVD * 100) + '% of vehicle-days \xb7 ' + vCount + ' vehicles' : '';
    document.getElementById('pNot').textContent       = totalVD ? Math.round(totalNotc / totalVD * 100) + '% of vehicle-days \xb7 ' + vCount + ' vehicles' : '';
    document.getElementById('pNone').textContent      = totalVD ? Math.round(totalNoi  / totalVD * 100) + '% of vehicle-days \xb7 ' + vCount + ' vehicles' : '';
  }

  // -- Fleet bar chart (pure SVG) -----------------------------------------------

  function _renderChart(yyyy, mm) {
    var container = document.getElementById('chartContainer');
    if (!container || !_mDayTotals.length) return;

    var W       = container.offsetWidth || 600;
    var H       = 150;
    var padL    = 28;
    var padR    = 8;
    var padT    = 8;
    var padB    = 20;
    var chartW  = W - padL - padR;
    var chartH  = H - padT - padB;
    var numDays = _mDayTotals.length;
    var barW    = Math.max(2, Math.floor(chartW / numDays) - 1);
    var gap     = Math.floor(chartW / numDays) - barW;

    // Y-axis: scale to max of known (non-future) days only
    var maxV = 0;
    _mDayTotals.forEach(function(d) {
      if (!d.future) {
        var total = d.compliant + d.notcompliant + d.noinspection;
        if (total > maxV) maxV = total;
      }
    });
    if (maxV === 0) maxV = 1;

    var gridLines = [0, 0.25, 0.5, 0.75, 1];
    var monthName = _monthLabel(yyyy + '-' + String(mm).padStart(2, '0'));

    var svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" '
            + 'role="img" aria-label="Fleet compliance by day for ' + _esc(monthName) + '">';

    // Grid lines + y-axis labels
    gridLines.forEach(function(pct) {
      var y     = padT + chartH - Math.round(pct * chartH);
      var label = Math.round(pct * maxV);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y
           + '" stroke="#98A4AE" stroke-opacity="0.15" stroke-width="1"/>';
      svg += '<text x="' + (padL - 4) + '" y="' + (y + 4) + '" text-anchor="end" '
           + 'font-size="9" font-family="Arial" fill="#98A4AE">' + label + '</text>';
    });

    // Bars -- full stack for known days, dark blackout for future days
    _mDayTotals.forEach(function(d, i) {
      var x      = padL + i * (barW + gap);
      var yBase  = padT + chartH;
      var dayNum = i + 1;
      var dowStr = _dowName(d.day);

      svg += '<g>';

      if (d.future) {
        svg += '<title>' + _esc(monthName.split(' ')[0] + ' ' + dayNum + ' (' + dowStr + ') \xb7 Not yet occurred') + '</title>';
        svg += '<rect x="' + x + '" y="' + padT + '" width="' + barW + '" height="' + chartH + '" fill="#141428"/>';
      } else {
        var total = d.compliant + d.notcompliant + d.noinspection;
        var hComp = total > 0 ? Math.round(d.compliant    / maxV * chartH) : 0;
        var hNotc = total > 0 ? Math.round(d.notcompliant / maxV * chartH) : 0;
        var hNoi  = total > 0 ? Math.round(d.noinspection / maxV * chartH) : 0;
        var pComp = total > 0 ? Math.round(d.compliant    / total * 100) : 0;
        var pNotc = total > 0 ? Math.round(d.notcompliant / total * 100) : 0;
        var pNoi  = total > 0 ? Math.round(d.noinspection / total * 100) : 0;

        svg += '<title>' + _esc(monthName.split(' ')[0] + ' ' + dayNum + ' (' + dowStr + ')'
          + ' \xb7 ' + d.compliant    + ' compliant ('      + pComp + '%)'
          + ' \xb7 ' + d.notcompliant + ' not compliant ('  + pNotc + '%)'
          + ' \xb7 ' + d.noinspection + ' no insp. needed (' + pNoi  + '%)') + '</title>';

        if (hComp > 0) svg += '<rect x="' + x + '" y="' + (yBase - hComp) + '" width="' + barW + '" height="' + hComp + '" fill="#84BD00"/>';
        if (hNotc > 0) svg += '<rect x="' + x + '" y="' + (yBase - hComp - hNotc) + '" width="' + barW + '" height="' + hNotc + '" fill="#CF4520"/>';
        if (hNoi  > 0) svg += '<rect x="' + x + '" y="' + (yBase - hComp - hNotc - hNoi) + '" width="' + barW + '" height="' + hNoi + '" fill="#3D76BF"/>';
      }

      svg += '</g>';

      if (dayNum === 1 || dayNum % 7 === 0 || dayNum === numDays) {
        svg += '<text x="' + (x + barW / 2) + '" y="' + (H - 4) + '" '
             + 'text-anchor="middle" font-size="9" font-family="Arial" fill="#98A4AE">' + dayNum + '</text>';
      }
    });

    svg += '</svg>';
    container.innerHTML = svg;

    var titleEl = document.getElementById('chartTitle');
    if (titleEl) titleEl.textContent = 'Fleet compliance by day \u2014 ' + monthName;

    var legendEl = document.getElementById('chartLegend');
    if (legendEl) {
      legendEl.innerHTML =
        '<div class="ldc-chart-legend-item"><div class="ldc-chart-legend-swatch" style="background:#84BD00"></div>Compliant</div>'
        + '<div class="ldc-chart-legend-item"><div class="ldc-chart-legend-swatch" style="background:#CF4520"></div>Not compliant</div>'
        + '<div class="ldc-chart-legend-item"><div class="ldc-chart-legend-swatch" style="background:#3D76BF"></div>No insp. needed</div>'
        + '<div class="ldc-chart-legend-item"><div class="ldc-chart-legend-swatch" style="background:#141428;border:1px solid rgba(152,164,174,0.3)"></div>Future</div>';
    }
  }

  // -- Monthly filter -----------------------------------------------------------

  function _mApplyFilter() {
    if (_mActiveFilter === 'all') {
      _mFilteredRows = _mAllRows.slice();
    } else if (_mActiveFilter === 'compliant') {
      _mFilteredRows = _mAllRows.filter(function(r) { return r.compDays > 0; });
    } else if (_mActiveFilter === 'notcompliant') {
      _mFilteredRows = _mAllRows.filter(function(r) { return r.notcDays > 0; });
    } else {
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

  // -- Monthly table ------------------------------------------------------------

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
      var stripW = 3 + r.numDays * 5 + 2;
      var dots   = '';
      r.dayStatuses.forEach(function(status, i) {
        var fill = status === 'compliant'    ? '#84BD00'
                 : status === 'notcompliant' ? '#CF4520'
                 : status === 'future'       ? '#141428'
                 :                            '#3D76BF';
        dots += '<circle cx="' + (3 + i * 5) + '" cy="7" r="2.5" fill="' + fill + '"/>';
      });
      var stripSvg = '<svg width="' + stripW + '" height="14" style="display:block" aria-hidden="true">' + dots + '</svg>';

      var compColor = r.compDays  > 0 ? '#84BD00' : '#98A4AE';
      var notcColor = r.notcDays  > 0 ? '#CF4520' : '#98A4AE';
      var inspColor = r.totalInsp > 0 ? '#009CDE' : '#98A4AE';

      html += '<tr>'
        + '<td style="font-weight:600">' + _esc(r.vehicleName) + '</td>'
        + '<td style="color:#98A4AE;font-size:12px">' + _esc(r.groupName || '-') + '</td>'
        + '<td>' + stripSvg + '</td>'
        + '<td style="text-align:center;color:' + compColor + ';font-weight:700;font-size:13px">' + r.compDays + '</td>'
        + '<td style="text-align:center;color:' + notcColor + ';font-weight:700;font-size:13px">' + r.notcDays + '</td>'
        + '<td style="text-align:center;color:#98A4AE;font-weight:700;font-size:13px">' + r.noiDays + '</td>'
        + '<td style="text-align:center;color:' + inspColor + ';font-weight:700;font-size:13px">' + r.totalInsp + '</td>'
        + '<td style="text-align:right;color:#98A4AE;font-size:12px">' + _esc(_fmt(r.totalDistM)) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    var fl = _mActiveFilter !== 'all' ? ' (filtered)' : '';
    document.getElementById('tableMeta').textContent =
      _mFilteredRows.length + ' vehicle' + (_mFilteredRows.length !== 1 ? 's' : '')
      + fl + ' \u2014 ' + _mAllRows.length + ' total';

    if (pagination) {
      pagination.style.display = 'flex';
      document.getElementById('pageInfo').textContent =
        'Page ' + _mPage + ' of ' + Math.max(1, totalPages)
        + ' \u2014 ' + (start + 1) + '\u2013' + end + ' of ' + _mFilteredRows.length;
      document.getElementById('prevBtn').disabled = _mPage <= 1;
      document.getElementById('nextBtn').disabled = _mPage >= totalPages;
    }
  }

  // -- Daily summary cards ------------------------------------------------------

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

  // -- Daily filter -------------------------------------------------------------

  function filter(f) {
    _activeFilter = f; _page = 1;
    var m = { all: 'fa', compliant: 'fc', notcompliant: 'fn', noinspection: 'fni' };
    _setFilterBtn(m[f]); _applyFilter();
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

  // -- Unified filter dispatcher ------------------------------------------------

  function filterAny(f) {
    if (_activeTab === 'monthly') {
      _mActiveFilter = f; _mPage = 1;
      var mm = { all: 'fa', compliant: 'fc', notcompliant: 'fn', noinspection: 'fni' };
      _mSetFilterBtn(mm[f]); _mApplyFilter();
    } else {
      filter(f);
    }
  }

  // -- Daily table --------------------------------------------------------------

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

  // -- Pagination ---------------------------------------------------------------

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

  // -- CSV export ---------------------------------------------------------------

  function exportCSV() {
    if (_activeTab === 'monthly') { _exportCSVMonthly(); return; }
    if (!_allRows.length) return;
    var dv    = document.getElementById('reportDate') && document.getElementById('reportDate').value;
    var lines = ['Date,Vehicle Name,Group,Compliance Status,Inspected,Inspections Submitted,Vehicle Moved,Distance'];
    _allRows.forEach(function(r) {
      var lb = r.status === 'compliant' ? 'Compliant'
             : r.status === 'notcompliant' ? 'Not Compliant' : 'No Inspection Needed';
      lines.push([dv, r.vehicleName, r.groupName || '', lb,
        r.inspCnt > 0 ? 'Inspected' : 'Not Inspected', r.inspCnt,
        r.moved ? 'Vehicle Moved' : 'Vehicle Did Not Move', r.distDisplay
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    _downloadCSV(lines, 'lytx-dvir-compliance-' + dv + '.csv');
  }

  function _exportCSVMonthly() {
    if (!_mAllRows.length) return;
    var ym    = document.getElementById('reportMonth') && document.getElementById('reportMonth').value;
    var lines = ['Month,Vehicle Name,Group,Compliant Days,Not Compliant Days,No Inspection Days,Inspections Submitted,Total Distance'];
    _mAllRows.forEach(function(r) {
      lines.push([ym, r.vehicleName, r.groupName || '',
        r.compDays, r.notcDays, r.noiDays, r.totalInsp, _fmt(r.totalDistM)
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    _downloadCSV(lines, 'lytx-dvir-compliance-monthly-' + ym + '.csv');
  }

  function _downloadCSV(lines, filename) {
    var blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // -- Shared device map builder ------------------------------------------------

  function _buildDeviceMap(devices, gm) {
    var dm = {};
    devices.forEach(function(d) {
      if (d.activeTo && new Date(d.activeTo) < new Date()) return;
      var isVehicle = false;
      if (d.groups) d.groups.forEach(function(dg) { if (dg.id === 'GroupVehicleId') isVehicle = true; });
      if (!isVehicle) return;

      var chosen = null, gn = '';
      if (d.groups) {
        for (var i = 0; i < d.groups.length; i++) {
          if (!_isBuiltinGroup(d.groups[i].id)) { chosen = d.groups[i].id; break; }
        }
      }
      if (chosen) gn = (gm[chosen] && gm[chosen].name) || chosen;

      var allGroupIds = [];
      if (d.groups) d.groups.forEach(function(dg) { if (!_isBuiltinGroup(dg.id)) allGroupIds.push(dg.id); });

      dm[d.id] = { name: d.name || d.id, groupName: gn, rawGroupId: chosen || '', allGroupIds: allGroupIds };
    });
    return dm;
  }

  // -- Shared group filter ------------------------------------------------------

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

  // -- Shared threshold reader --------------------------------------------------

  function _getThreshold() {
    var el = document.getElementById('distanceThreshold');
    return el ? parseFloat(el.value) || 0 : 2;
  }

  // -- Loading / error states ---------------------------------------------------

  function _setLoading() {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box"><p>Loading data\u2026</p></div>';
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
    document.getElementById('tableMeta').textContent = 'Loading\u2026';
    document.getElementById('runBtn').disabled = true;
  }

  function _setLoadingMessage(msg) {
    var tc = document.getElementById('tableContainer');
    if (tc) tc.innerHTML = '<div class="ldc-state-box"><p>' + _esc(msg) + '</p></div>';
  }

  function _resetBtn() {
    var btn = document.getElementById('runBtn');
    if (!btn) return;
    btn.disabled = false; btn.textContent = 'Run Report';
  }

  function _showError(msg) {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box" style="color:#CF4520"><p>' + _esc(msg) + '</p></div>';
    _resetBtn();
  }

  // -- Group panel --------------------------------------------------------------

  function groupNav(gid) {
    _navGroupId = gid; _selectedGroupId = gid;
    var lbl = document.getElementById('groupFilterLabel');
    if (lbl) lbl.textContent = (_groupMap[gid] && _groupMap[gid].name) || 'All Groups';
    _renderGroupPanel();
  }

  function groupSelect(gid) {
    _selectedGroupId = gid; _navGroupId = gid;
    var lbl = document.getElementById('groupFilterLabel');
    if (lbl) lbl.textContent = (_groupMap[gid] && _groupMap[gid].name) || 'All Groups';
    _renderGroupPanel();
  }

  function toggleGroupPanel() {
    var panel = document.getElementById('groupPanel');
    if (!panel) return;
    if (panel.style.display === 'none' || panel.style.display === '') {
      _navGroupId = _selectedGroupId;
      _renderGroupPanel();
      panel.style.display = 'block';
      setTimeout(function() { document.addEventListener('click', _outsideClickHandler); }, 0);
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

  // -- Public API ---------------------------------------------------------------

  return {
    init: init, run: run, switchTab: switchTab,
    filter: filter, filterAny: filterAny,
    prevPage: prevPage, nextPage: nextPage,
    exportCSV: exportCSV,
    groupNav: groupNav, groupSelect: groupSelect, toggleGroupPanel: toggleGroupPanel
  };

}());
