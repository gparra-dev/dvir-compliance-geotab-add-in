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
  var _api = null;
  var _state = null;
  var _allRows = [];
  var _filteredRows = [];
  var _activeFilter = 'all';
  var _page = 1;
  var _pageSize = 50;
  var _isMetric = true;
  var _groupMap = {};        // id -> { name, parent, children[] }
  var _selectedGroupId = null; // currently selected group filter

  // Geotab built-in group IDs always match /^Group[A-Z]/
  // Real customer fleet group IDs are short alphanumeric strings like 'b2842'
  function _isBuiltinGroup(gid) {
    return /^Group[A-Z]/.test(gid);
  }

  function init(api, state) {
    _api = api;
    _state = state;
    var t = new Date();
    var yyyy = t.getUTCFullYear();
    var mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(t.getUTCDate()).padStart(2, '0');
    document.getElementById('reportDate').value = yyyy + '-' + mm + '-' + dd;

    // Fetch user prefs and groups in parallel
    _api.multiCall([
      ['Get', { typeName: 'User', search: {} }],
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

  function _buildGroupTree(groups, user) {
    // Build id -> group map with children array
    _groupMap = {};
    groups.forEach(function(g) {
      _groupMap[g.id] = {
        id: g.id,
        name: g.name || g.id,
        parent: g.parent && g.parent.id,
        children: []
      };
    });

    // Link children to parents
    var roots = [];
    groups.forEach(function(g) {
      var pid = g.parent && g.parent.id;
      if (pid && _groupMap[pid]) {
        _groupMap[pid].children.push(g.id);
      } else if (!_isBuiltinGroup(g.id)) {
        roots.push(g.id);
      }
    });

    // Find top-level accessible groups (non-built-in roots)
    // If user has a group filter set, use that; otherwise use first real root
    var topGroup = null;
    if (user && user.companyGroups && user.companyGroups.length > 0) {
      for (var i = 0; i < user.companyGroups.length; i++) {
        var gid = user.companyGroups[i].id;
        if (!_isBuiltinGroup(gid)) { topGroup = gid; break; }
      }
    }
    if (!topGroup && roots.length > 0) { topGroup = roots[0]; }
    _selectedGroupId = topGroup;

    // Populate the group dropdown
    _populateGroupDropdown(topGroup);
  }

  function _populateGroupDropdown(selectedId) {
    var sel = document.getElementById('groupFilter');
    if (!sel) return;
    sel.innerHTML = '';

    // Build flat list from hierarchy, indented by depth
    function _addOptions(gid, depth) {
      if (!_groupMap[gid] || _isBuiltinGroup(gid)) return;
      var opt = document.createElement('option');
      opt.value = gid;
      opt.textContent = (depth > 0 ? '    '.repeat(depth) : '') + _groupMap[gid].name;
      if (gid === selectedId) opt.selected = true;
      sel.appendChild(opt);
      // Recurse into children, filtering built-ins
      var children = _groupMap[gid].children || [];
      children.forEach(function(cid) { _addOptions(cid, depth + 1); });
    }

    // Find top-level non-built-in groups
    var tops = Object.keys(_groupMap).filter(function(gid) {
      if (_isBuiltinGroup(gid)) return false;
      var pid = _groupMap[gid].parent;
      return !pid || _isBuiltinGroup(pid);
    });

    tops.forEach(function(gid) { _addOptions(gid, 0); });
  }

  // Returns all descendant IDs of a group (inclusive)
  function _getGroupAndDescendants(gid) {
    var result = {};
    function _walk(id) {
      result[id] = true;
      var g = _groupMap[id];
      if (g && g.children) {
        g.children.forEach(function(cid) { _walk(cid); });
      }
    }
    _walk(gid);
    return result;
  }

  function run() {
    var dv = document.getElementById('reportDate').value;
    if (!dv) { _showError('Please select a date.'); return; }

    // Capture selected group from dropdown
    var sel = document.getElementById('groupFilter');
    if (sel && sel.value) { _selectedGroupId = sel.value; }

    _setLoading();

    var from = dv + 'T00:00:00.000Z';
    var to   = dv + 'T23:59:59.999Z';

    // Simple searches without group filtering to avoid JSON errors
    // Geotab will scope results to the logged-in user's groups automatically
    var tripSearch   = { fromDate: from, toDate: to };
    var dvirSearch   = { fromDate: from, toDate: to };
    var deviceSearch = {};

    _api.multiCall([
      ['Get', { typeName: 'Trip',    search: tripSearch   }],
      ['Get', { typeName: 'DVIRLog', search: dvirSearch   }],
      ['Get', { typeName: 'Device',  search: deviceSearch }],
      ['Get', { typeName: 'Group',   search: {}           }]
    ],
    function(results) {
      _process(results);
    },
    function(e) {
      _showError('API error: ' + (e && e.message ? e.message : String(e)));
    });
  }

  function _process(results) {
    var trips   = (results && results[0]) || [];
    var dvirs   = (results && results[1]) || [];
    var devices = (results && results[2]) || [];
    var groups  = (results && results[3]) || [];

    // Build group lookup: id -> { name, parent }
    var gm = {};
    groups.forEach(function(g) {
      gm[g.id] = { name: g.name || g.id, parent: g.parent && g.parent.id };
    });


    // Calculate depth of a group by walking up the parent chain
    function _groupDepth(gid) {
      var depth = 0;
      var visited = {};
      var current = gid;
      while (current && gm[current] && gm[current].parent && !visited[current]) {
        visited[current] = true;
        current = gm[current].parent;
        depth++;
      }
      return depth;
    }



    // Build device map — pick the first fleet group (non-built-in ID)
    var dm = {};
    devices.forEach(function(d) {
      var gn = '';
      if (d.groups && d.groups.length > 0) {
        var chosen = null;
        for (var i = 0; i < d.groups.length; i++) {
          var gid = d.groups[i].id;
          if (!_isBuiltinGroup(gid)) {
            chosen = gid;
            break;
          }
        }
        if (chosen) {
          gn = (gm[chosen] && gm[chosen].name) || chosen;
        } else {
          // All groups were built-in — show nothing rather than a misleading name
          gn = '';
        }
      }
      dm[d.id] = { name: d.name || d.id, groupName: gn, rawGroupId: chosen || '' };
    });

    // Sum distance per device — Geotab Trip.distance is in meters
    var dist = {};
    trips.forEach(function(t) {
      var did = t.device && t.device.id;
      if (!did) return;
      // distance can be a float in meters; default to 0 if missing
      var d = (typeof t.distance === 'number') ? t.distance : 0;
      dist[did] = (dist[did] || 0) + d;
    });

    // Count DVIR logs per device
    var insp = {};
    dvirs.forEach(function(l) {
      var did = l.device && l.device.id;
      if (!did) return;
      insp[did] = (insp[did] || 0) + 1;
    });

    // Union of all device IDs that had trips or inspections
    var ids = {};
    Object.keys(dist).forEach(function(k) { ids[k] = true; });
    Object.keys(insp).forEach(function(k) { ids[k] = true; });
    // Also include all known devices (so parked vehicles show up)
    Object.keys(dm).forEach(function(k) { ids[k] = true; });

    var rows = [];
    Object.keys(ids).forEach(function(did) {
      var dev      = dm[did] || { name: did, groupName: '' };
      var distM    = dist[did] || 0;
      var inspCnt  = insp[did] || 0;
      var moved    = distM > 0;
      var status   = !moved ? 'noinspection' : (inspCnt > 0 ? 'compliant' : 'notcompliant');

      rows.push({
        deviceId:    did,
        vehicleName: dev.name,
        groupName:   dev.groupName,
        rawGroupId:  dev.rawGroupId,
        status:      status,
        inspCnt:     inspCnt,
        moved:       moved,
        distDisplay: _fmt(distM)
      });
    });

    // Filter rows to selected group and its descendants
    if (_selectedGroupId && Object.keys(_groupMap).length > 0) {
      var allowedGroups = _getGroupAndDescendants(_selectedGroupId);
      rows = rows.filter(function(r) {
        if (!r.rawGroupId) return true; // no group info, include it
        return allowedGroups[r.rawGroupId];
      });
    }

    // Sort: Not Compliant first, then Compliant, then No Inspection Needed
    var ord = { notcompliant: 0, compliant: 1, noinspection: 2 };
    rows.sort(function(a, b) {
      return (ord[a.status] - ord[b.status]) || a.vehicleName.localeCompare(b.vehicleName);
    });

    _allRows = rows;
    _activeFilter = 'all';
    _page = 1;
    _updateSummary();
    _setFilterBtn('fa');
    _applyFilter();
    _resetBtn();
  }

  function _fmt(m) {
    if (!m) return '0';
    return _isMetric ? m.toFixed(1) + ' km' : (m / 1.60934).toFixed(1) + ' mi';
  }

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
      if (r.status === 'compliant')     { bc = 'ldc-badge-green'; label = 'Compliant'; }
      else if (r.status === 'notcompliant') { bc = 'ldc-badge-red';   label = 'Not Compliant'; }
      else                              { bc = 'ldc-badge-grey';  label = 'No Inspection Needed'; }

      var inspColor = r.inspCnt > 0 ? '#009CDE' : '#98A4AE';
      var moveColor = r.moved ? '#FFFFFF' : '#98A4AE';

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

  function prevPage() { if (_page > 1) { _page--; _renderTable(); } }
  function nextPage() {
    if (_page < Math.ceil(_filteredRows.length / _pageSize)) { _page++; _renderTable(); }
  }

  function exportCSV() {
    if (!_allRows.length) return;
    var dv = document.getElementById('reportDate').value;
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
      ].map(function(v) {
        return '"' + String(v).replace(/"/g, '""') + '"';
      }).join(','));
    });
    var sep = String.fromCharCode(10);
    var blob = new Blob([lines.join(sep)], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href   = url;
    a.download = 'lytx-dvir-compliance-' + dv + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function _setLoading() {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box"><p>Loading data...</p></div>';
    var pag = document.getElementById('pagination');
    if (pag) pag.style.display = 'none';
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
    btn.disabled = false;
    btn.textContent = 'Run Report';
  }

  function _showError(msg) {
    document.getElementById('tableContainer').innerHTML =
      '<div class="ldc-state-box" style="color:#CF4520"><p>' + _esc(msg) + '</p></div>';
    _resetBtn();
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init: init, run: run, filter: filter, prevPage: prevPage, nextPage: nextPage, exportCSV: exportCSV };
}());
