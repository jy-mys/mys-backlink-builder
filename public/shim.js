/* Replaces the claude.ai artifact runtime. The page calls window.claude.use('mcp')
   and window.claude.use('user'); both are backed by this app's own server. */
(function(){
  function fail(code, message, retryable, retryAfterMs){
    var e = {code: code, message: message || ''};
    if (retryable) { e.retryable = true; e.retryAfterMs = retryAfterMs || 1500; }
    return e;
  }
  function readError(res){
    return res.json().catch(function(){ return null; }).then(function(body){
      var e = body && body.error;
      if (e && e.code) throw fail(e.code, e.message, e.retryable, e.retryAfterMs);
      if (res.status === 401) throw fail('not_granted', 'Not signed in');
      throw fail('upstream_error', 'HTTP ' + res.status, res.status >= 500, 1500);
    });
  }
  function network(){ throw fail('upstream_error', 'Network error', true, 1500); }

  var mcp = {
    // The 4th argument (e.g. {cache:false}) is a claude.ai hint; nothing is cached here.
    callTool: function(server, tool, input){
      return fetch('/api/tool', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({server: server, tool: tool, input: input})
      }).then(function(res){
        if (!res.ok) return readError(res);
        return res.json().then(function(body){ return {payload: body.payload}; });
      }, network);
    }
  };
  var user = {
    me: function(){
      return fetch('/api/me', {credentials: 'same-origin'}).then(function(res){
        if (!res.ok) return readError(res);
        return res.json().then(function(body){ return {name: body.name || ''}; });
      }, network);
    }
  };

  // Buttons beside "Open tracker sheet": "Check live links" for everyone signed in (opens
  // /links for the client picked in step 1), and "Manage interns" for staff only.
  // Added here so public/index.html stays the original page.
  function addButton(id, text, href, after){
    var a = document.createElement('a');
    a.id = id;
    a.className = 'btn sheetbtn';
    a.href = href;
    a.textContent = text;
    after.parentNode.insertBefore(a, after.nextSibling);
    return a;
  }
  fetch('/api/me', {credentials: 'same-origin'}).then(function(res){
    return res.ok ? res.json() : null;
  }).then(function(body){
    var anchor = document.getElementById('tabLink');
    if (!body || !anchor || document.getElementById('mbbLinks')) return;
    var links = addButton('mbbLinks', 'Check live links', '/links', anchor);
    links.addEventListener('click', function(){
      var sel = document.getElementById('clientSel');
      links.href = '/links' + (sel && sel.value ? '?tab=' + encodeURIComponent(sel.value) : '');
    });
    if (body.staff) addButton('mbbStaff', 'Manage interns', '/staff', links);
  }, function(){});

  // Column filters for "Everything to build": a row of dropdowns under the table headings
  // (Status, Who can do it, Priority, Cost, Link value, and the SEO columns). The page redraws
  // the table on every change, so the filter row is re-added and the filters re-applied after
  // each redraw. Hidden rows take their open detail rows with them.
  var FILTER_COLS = {'Status': 'Status', 'Who can do it': 'Who', 'Priority': 'Priority', 'Cost': 'Cost',
    'Link value': 'Link value', 'Verdict': 'Verdict', 'Link type': 'Link type', 'MY traffic / mo': 'MY traffic', 'Spam risk': 'Spam risk'};
  var filters = {}, pageCount = '';
  function cellValue(td){
    var sel = td.querySelector('select');
    if (sel) return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
    if (td.querySelector('[data-addtab]')) return 'Not on tab yet';
    return td.textContent.replace(/\s+/g, ' ').trim() || '-';
  }
  function headLabel(th){
    var c = th.cloneNode(true);
    c.querySelectorAll('.info').forEach(function(b){ b.remove(); });
    return c.textContent.trim();
  }
  function activeFilters(){ return Object.keys(filters).filter(function(k){ return filters[k]; }); }
  function setupFilters(){
    var thead = document.getElementById('thead'), tbody = document.getElementById('rows');
    if (!thead || !tbody) return;
    var style = document.createElement('style');
    style.id = 'mbbFilterCss';
    style.textContent = '.mbb-frow th{position:sticky;top:41px;z-index:2;background:var(--thead);padding:0 12px 8px;border-bottom:1px solid var(--line);font-weight:400}' +
      '.mbb-frow select{width:100%;min-width:90px;font:inherit;font-size:12px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit}' +
      '.mbb-frow select.on{border-color:var(--ink-btn);font-weight:600}' +
      '.mbb-frow .mbb-clear{font-size:12px}' +
      '@media (max-width:640px){.tbl thead{display:block}.tbl thead tr:first-child{display:none}' +
      '.tbl thead tr.mbb-frow{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:12px}.tbl thead tr.mbb-frow th{position:static;padding:0;border:0;background:none;white-space:normal}' +
      '.tbl thead tr.mbb-frow th.mbb-none{display:none}.mbb-frow th[data-l]::before{content:attr(data-l);display:block;font-size:12px;color:var(--muted)}}';
    document.head.appendChild(style);
    var observer = new MutationObserver(function(){ observer.disconnect(); refresh(); watch(); });
    function watch(){ observer.observe(thead, {childList: true}); observer.observe(tbody, {childList: true}); }

    function refresh(){
      var head = thead.querySelector('tr:not(.mbb-frow)');
      if (!head) return;
      var ths = Array.prototype.slice.call(head.children);
      var labels = ths.map(headLabel);
      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr.r'));
      // Distinct values per filterable column, from the rows the page is showing.
      var opts = {};
      labels.forEach(function(l){ if (FILTER_COLS[l]) opts[l] = {}; });
      rows.forEach(function(tr){
        labels.forEach(function(l){
          if (!opts[l]) return;
          var td = tr.querySelector('td[data-l="' + FILTER_COLS[l] + '"]');
          if (td) { var v = cellValue(td); opts[l][v] = (opts[l][v] || 0) + 1; }
        });
      });
      var old = thead.querySelector('.mbb-frow'); if (old) old.remove();
      var fr = document.createElement('tr');
      fr.className = 'mbb-frow';
      labels.forEach(function(l){
        var th = document.createElement('th');
        if (opts[l]) {
          th.setAttribute('data-l', l);
          var sel = document.createElement('select');
          sel.setAttribute('data-mbbf', l);
          sel.setAttribute('aria-label', 'Filter by ' + l);
          var html = '<option value="">All</option>';
          var keys = Object.keys(opts[l]);
          if (filters[l] && keys.indexOf(filters[l]) < 0) keys.push(filters[l]);
          keys.forEach(function(v){
            var o = document.createElement('option');
            o.value = v; o.textContent = v + ' (' + (opts[l][v] || 0) + ')';
            sel.appendChild(o);
          });
          sel.insertAdjacentHTML('afterbegin', html);
          sel.value = filters[l] || '';
          if (filters[l]) sel.className = 'on';
          th.appendChild(sel);
        } else if (l === 'Site' && activeFilters().length) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'linkbtn mbb-clear'; b.textContent = 'Clear filters';
          th.appendChild(b);
        } else {
          th.className = 'mbb-none';
        }
        fr.appendChild(th);
      });
      thead.appendChild(fr);
      apply(rows, labels.length);
    }

    function apply(rows, ncol){
      var on = activeFilters();
      var empty = tbody.querySelector('.mbb-empty'); if (empty) empty.remove();
      var shown = 0;
      Array.prototype.slice.call(tbody.children).forEach(function(tr){ tr.style.display = ''; });
      // Keep the page's own "Showing X of Y" so clearing the filters can put it back.
      var count = document.getElementById('count');
      if (count && !/\(filtered\)$/.test(count.textContent)) pageCount = count.textContent;
      if (!on.length) { if (count && pageCount) count.textContent = pageCount; return; }
      rows.forEach(function(tr){
        var ok = on.every(function(l){
          var td = tr.querySelector('td[data-l="' + FILTER_COLS[l] + '"]');
          return !td || cellValue(td) === filters[l];
        });
        if (ok) shown++;
        // Hide the row and the detail or check rows that follow it.
        for (var n = tr; n && (n === tr || !n.classList.contains('r')); n = n.nextElementSibling) n.style.display = ok ? '' : 'none';
      });
      var m = pageCount.match(/of (\d+)/);
      if (m) count.textContent = 'Showing ' + shown + ' of ' + m[1] + ' (filtered)';
      if (!shown && rows.length) {
        var e = document.createElement('tr');
        e.className = 'mbb-empty';
        e.innerHTML = '<td colspan="' + ncol + '" class="empty">No sites match these filters. <button type="button" class="linkbtn mbb-clear">Clear filters</button></td>';
        tbody.appendChild(e);
      }
    }

    document.addEventListener('change', function(ev){
      var t = ev.target;
      if (!t.hasAttribute || !t.hasAttribute('data-mbbf')) return;
      filters[t.getAttribute('data-mbbf')] = t.value;
      observer.disconnect(); refresh(); watch();
    });
    document.addEventListener('click', function(ev){
      if (!ev.target.closest || !ev.target.closest('.mbb-clear')) return;
      filters = {};
      observer.disconnect(); refresh(); watch();
    });
    refresh(); watch();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupFilters);
  else setupFilters();

  window.claude = {
    use: function(name){
      return Promise.resolve(name === 'mcp' ? mcp : name === 'user' ? user : null);
    }
  };
})();
