// Lytx DVIR Compliance Add-In
// Geotab Add-In lifecycle entry point
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
  var _api=null,_state=null,_allRows=[],_filteredRows=[],_activeFilter='all',_page=1,_pageSize=50,_isMetric=true;

  function init(api,state){
    _api=api;_state=state;
    var t=new Date();
    document.getElementById('reportDate').value=
      t.getUTCFullYear()+'-'+String(t.getUTCMonth()+1).padStart(2,'0')+'-'+String(t.getUTCDate()).padStart(2,'0');
    _api.call('Get',{typeName:'User',search:{}},function(u){if(u&&u[0])_isMetric=u[0].isMetric!==false;},function(){});
  }

  function run(){
    var dv=document.getElementById('reportDate').value;
    if(!dv){_showError('Please select a date.');return;}
    _setLoading();
    var from=dv+'T00:00:00.000Z',to=dv+'T23:59:59.999Z';
    var gf=(_state&&_state.getGroupFilter)?_state.getGroupFilter():[];
    var ts={fromDate:from,toDate:to},ds={fromDate:from,toDate:to},devs={fromDate:from,toDate:to};
    if(gf&&gf.length>0){
      var g=gf.map(function(x){return{id:x};});
      ts.deviceSearch={groups:g};ds.deviceSearch={groups:g};devs.groups=g;
    }
    _api.multiCall([
      ['Get',{typeName:'Trip',search:ts}],
      ['Get',{typeName:'DVIRLog',search:ds}],
      ['Get',{typeName:'Device',search:devs}]
    ],function(r){_process(r);},function(e){_showError('API error: '+(e&&e.message?e.message:String(e)));});
  }

  function _process(results){
    var trips=(results&&results[0])||[],dvirs=(results&&results[1])||[],devices=(results&&results[2])||[];
    var dm={};
    devices.forEach(function(d){dm[d.id]={id:d.id,name:d.name||d.id,groups:d.groups||[]};});
    var dist={};
    trips.forEach(function(t){
      var did=t.device&&t.device.id;if(!did)return;
      dist[did]=(dist[did]||0)+(t.distance||0);
      if(!dm[did])dm[did]={id:did,name:did,groups:[]};
    });
    var insp={};
    dvirs.forEach(function(l){
      var did=l.device&&l.device.id;if(!did)return;
      insp[did]=(insp[did]||0)+1;
      if(!dm[did])dm[did]={id:did,name:did,groups:[]};
    });
    var ids={};
    [dm,dist,insp].forEach(function(o){Object.keys(o).forEach(function(k){ids[k]=true;});});
    var rows=[];
    Object.keys(ids).forEach(function(did){
      var dev=dm[did]||{id:did,name:did,groups:[]};
      var distM=dist[did]||0,inspCnt=insp[did]||0,moved=distM>0;
      var status=!moved?'noinspection':inspCnt>0?'compliant':'notcompliant';
      var gn=(dev.groups&&dev.groups.length>0)?(dev.groups[0].id||''):'';
      rows.push({deviceId:did,vehicleName:dev.name,groupName:gn,status:status,inspCnt:inspCnt,moved:moved,distM:distM,distDisplay:_fmt(distM)});
    });
    var ord={notcompliant:0,compliant:1,noinspection:2};
    rows.sort(function(a,b){return(ord[a.status]-ord[b.status])||a.vehicleName.localeCompare(b.vehicleName);});
    _allRows=rows;_activeFilter='all';_page=1;
    _updateSummary();_setFilterBtn('fa');_applyFilter();_resetBtn();
  }

  function _fmt(m){
    if(!m)return'0';
    return _isMetric?(m/1000).toFixed(1)+' km':(m/1609.344).toFixed(1)+' mi';
  }

  function _updateSummary(){
    var c=_allRows.filter(function(r){return r.status==='compliant';}).length;
    var n=_allRows.filter(function(r){return r.status==='notcompliant';}).length;
    var ni=_allRows.filter(function(r){return r.status==='noinspection';}).length;
    var total=_allRows.length;
    document.getElementById('cCompliant').textContent=c;
    document.getElementById('cNot').textContent=n;
    document.getElementById('cNone').textContent=ni;
    document.getElementById('pCompliant').textContent=total?Math.round(c/total*100)+'% of fleet':'';
    document.getElementById('pNot').textContent=total?Math.round(n/total*100)+'% of fleet':'';
    document.getElementById('pNone').textContent=total?Math.round(ni/total*100)+'% of fleet':'';
  }

  function filter(f){
    _activeFilter=f;_page=1;
    var m={all:'fa',compliant:'fc',notcompliant:'fn',noinspection:'fni'};
    _setFilterBtn(m[f]);_applyFilter();
  }

  function _setFilterBtn(id){
    ['fa','fc','fn','fni'].forEach(function(x){
      var el=document.getElementById(x);if(el)el.className='filter-btn'+(x===id?' active':'');
    });
  }

  function _applyFilter(){
    _filteredRows=_activeFilter==='all'?_allRows.slice():_allRows.filter(function(r){return r.status===_activeFilter;});
    _renderTable();
  }

  function _renderTable(){
    var container=document.getElementById('tableContainer');
    var pagination=document.getElementById('pagination');
    if(!_filteredRows.length){
      container.innerHTML='<div class="state-box"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg><p>No vehicles match this filter</p></div>';
      if(pagination)pagination.style.display='none';
      document.getElementById('tableMeta').textContent=_allRows.length+' vehicle'+(_allRows.length!==1?'s':'')+' total';
      return;
    }
    var tp=Math.ceil(_filteredRows.length/_pageSize);
    if(_page>tp)_page=tp;
    var start=(_page-1)*_pageSize,end=Math.min(start+_pageSize,_filteredRows.length);
    var pr=_filteredRows.slice(start,end);
    var html='<div class="table-wrap"><table><thead><tr><th>Vehicle</th><th>Group</th><th>Compliance</th><th>Inspected</th><th>Inspections</th><th>Vehicle Moved</th><th>Distance</th></tr></thead><tbody>';
    pr.forEach(function(r){
      var bc=r.status==='compliant'?'compliant':r.status==='notcompliant'?'not-compliant':'no-inspection';
      var dc=r.status==='compliant'?'green':r.status==='notcompliant'?'red':'grey';
      var lb=r.status==='compliant'?'Compliant':r.status==='notcompliant'?'Not Compliant':'No Inspection Needed';
      var ic=r.inspCnt>0?'var(--lytx-light-blue)':'var(--text-muted)';
      var mc=r.moved?'#fff':'var(--text-muted)';
      html+='<tr>'
        +'<td style="font-weight:600;font-size:13px">'+_esc(r.vehicleName)+'</td>'
        +'<td style="color:var(--text-muted);font-size:12px">'+_esc(r.groupName||'—')+'</td>'
        +'<td><span class="badge '+bc+'"><span class="dot '+dc+'"></span>'+lb+'</span></td>'
        +'<td style="color:'+mc+';font-size:12px">'+(r.inspCnt>0?'Inspected':'Not Inspected')+'</td>'
        +'<td style="color:'+ic+';font-size:12px;font-weight:600">'+r.inspCnt+'</td>'
        +'<td style="color:'+mc+';font-size:12px">'+(r.moved?'Vehicle Moved':'Did Not Move')+'</td>'
        +'<td style="color:'+mc+';font-size:12px">'+_esc(r.distDisplay)+'</td>'
        +'</tr>';
    });
    html+='</tbody></table></div>';
    container.innerHTML=html;
    var fl=_activeFilter!=='all'?' (filtered)':'';
    document.getElementById('tableMeta').textContent=_filteredRows.length+' vehicle'+(_filteredRows.length!==1?'s':'')+fl+' • '+_allRows.length+' total';
    if(pagination){
      pagination.style.display='flex';
      document.getElementById('pageInfo').textContent='Page '+_page+' of '+Math.max(1,tp)+' — '+(start+1)+'–'+end+' of '+_filteredRows.length;
      document.getElementById('prevBtn').disabled=_page<=1;
      document.getElementById('nextBtn').disabled=_page>=tp;
    }
  }

  function prevPage(){if(_page>1){_page--;_renderTable();}}
  function nextPage(){if(_page<Math.ceil(_filteredRows.length/_pageSize)){_page++;_renderTable();}}

  function exportCSV(){
    if(!_allRows.length)return;
    var dv=document.getElementById('reportDate').value;
    var lines=['Date,Vehicle Name,Group,Compliance Status,Inspected,Inspections Submitted,Vehicle Moved,Distance'];
    _allRows.forEach(function(r){
      var lb=r.status==='compliant'?'Compliant':r.status==='notcompliant'?'Not Compliant':'No Inspection Needed';
      lines.push([dv,r.vehicleName,r.groupName||'',lb,r.inspCnt>0?'Inspected':'Not Inspected',r.inspCnt,r.moved?'Vehicle Moved':'Vehicle Did Not Move',r.distDisplay]
        .map(function(v){return'"'+String(v).replace(/"/g,'""')+'"';}).join(','));
    });
    var blob=new Blob([lines.join(String.fromCharCode(10))],{type:'text/csv'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download='lytx-plus-dvir-compliance-'+dv+'.csv';
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  }

  function _setLoading(){
    document.getElementById('tableContainer').innerHTML='<div class="state-box loading"><div class="spinner"></div><p>Loading inspection and trip data…</p></div>';
    var pag=document.getElementById('pagination');if(pag)pag.style.display='none';
    ['cCompliant','cNot','cNone'].forEach(function(id){document.getElementById(id).textContent='—';});
    ['pCompliant','pNot','pNone'].forEach(function(id){document.getElementById(id).textContent='';});
    document.getElementById('tableMeta').textContent='Loading…';
    document.getElementById('runBtn').disabled=true;
  }

  function _resetBtn(){
    var btn=document.getElementById('runBtn');btn.disabled=false;
    btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Run Report';
  }

  function _showError(msg){
    document.getElementById('tableContainer').innerHTML='<div class="state-box"><svg viewBox="0 0 24 24" stroke="#CF4520"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p class="err-msg">'+_esc(msg)+'</p></div>';
    _resetBtn();
  }

  function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  return{init:init,run:run,filter:filter,prevPage:prevPage,nextPage:nextPage,exportCSV:exportCSV};
}());
