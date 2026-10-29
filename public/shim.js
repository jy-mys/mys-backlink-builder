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

  window.claude = {
    use: function(name){
      return Promise.resolve(name === 'mcp' ? mcp : name === 'user' ? user : null);
    }
  };
})();
