(function(){
  var KEY='flowviz-theme';
  function read(){ var v=localStorage.getItem(KEY); if(!v) return {mode:'system',ts:0}; try{ return JSON.parse(v); }catch(e){ return {mode:v,ts:0}; } }
  function write(m){ try{ localStorage.setItem(KEY, JSON.stringify({mode:m, ts:Date.now()})); }catch(e){} }
  function sys(){ return (window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'; }
  function apply(m){
    document.documentElement.setAttribute('data-theme', m==='system'?sys():m);
    document.querySelectorAll('.opt').forEach(function(o){
      var on=o.getAttribute('data-mode')===m;
      o.classList.toggle('on', on);
      var t=o.querySelector('.tick');
      if(on&&!t) o.insertAdjacentHTML('beforeend','<span class="tick">✓ 正在用</span>');
      else if(!on&&t) t.remove();
    });
  }
  document.getElementById('gear').onclick=function(){ document.getElementById('settings').classList.toggle('open'); };
  // ?settings=1 直接展开外观面板（截图/分享链接时用）
  if(/[?&]settings=1/.test(location.search)) document.getElementById('settings').classList.add('open');
  document.querySelectorAll('.opt').forEach(function(o){
    o.onclick=function(){ write(o.getAttribute('data-mode')); apply(read().mode); };
  });
  if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').addEventListener){
    matchMedia('(prefers-color-scheme: light)').addEventListener('change',function(){ if(read().mode==='system') apply('system'); });
  }
  apply(read().mode);

  // 每张卡片标出「已锁定 / 单独设过颜色」——这些是这台设备上的本地状态
  function g(k){ var v=localStorage.getItem(k); if(!v) return null; try{ return JSON.parse(v); }catch(e){ return null; } }
  document.querySelectorAll('.card[data-file]').forEach(function(card){
    var f=card.getAttribute('data-file');
    var lock=g('flowviz-lock:'+f), own=g(KEY+':'+f);
    var box=card.querySelector('.cbody'), extra='';
    if(lock&&lock.locked) extra+='<span class="badge lock">🔒 已锁定 '+(lock.mode==='light'?'浅色':'深色')+'</span>';
    else if(own&&own.mode) extra+='<span class="badge own">单独设为'+(own.mode==='light'?'浅色':'深色')+'</span>';
    if(extra) box.insertAdjacentHTML('beforeend', extra);
  });

  /* ── 统计汇总 + 过滤 + 排序 + 最近打开 ── */
  var RECENT='flowviz-recent', grid=document.querySelector('.grid');
  var cards=Array.prototype.slice.call(document.querySelectorAll('.card[data-file]'));
  function recentList(){ var r=g(RECENT); return Array.isArray(r)?r:[]; }
  function noteRecent(f){
    var r=recentList().filter(function(x){ return x!==f; });
    r.unshift(f);
    try{ localStorage.setItem(RECENT, JSON.stringify(r.slice(0,8))); }catch(e){}
  }
  cards.forEach(function(c){ c.addEventListener('click', function(){ noteRecent(c.getAttribute('data-file')); }); });

  // 汇总：多少张、共多少环节、需关注（risk+hold）多少处
  var totNodes=0, totEdges=0, need=0, withNeed=0;
  cards.forEach(function(c){
    var st={};
    (c.getAttribute('data-status')||'').split(',').filter(Boolean).forEach(function(pair){
      var kv=pair.split(':'); st[kv[0]]=Number(kv[1])||0;
    });
    var meta=(c.querySelector('.cmeta')||{}).textContent||'';
    var mN=/^(\d+)\s*环节/.exec(meta); if(mN) totNodes+=Number(mN[1]);
    var mE=/(\d+)\s*连接/.exec(meta); if(mE) totEdges+=Number(mE[1]);
    var n=(st.risk||0)+(st.hold||0);
    if(n){ need+=n; withNeed++; }
  });
  var sum=document.getElementById('sum');
  if(sum) sum.textContent=cards.length+' 张 · 共 '+totNodes+' 环节 / '+totEdges+' 连接'+(need?(' · 需关注 '+need+' 处（'+withNeed+' 张图）'):'');

  // 最近打开徽标 + 排序
  var rec=recentList();
  function sortCards(mode){
    if(!grid) return;
    var arr=cards.slice();
    if(mode==='mtime') arr.sort(function(a,b){ return (Number(b.getAttribute('data-mtime'))||0)-(Number(a.getAttribute('data-mtime'))||0); });
    else if(mode==='recent') arr.sort(function(a,b){
      var ia=rec.indexOf(a.getAttribute('data-file')), ib=rec.indexOf(b.getAttribute('data-file'));
      if(ia<0&&ib<0) return a.getAttribute('data-file').localeCompare(b.getAttribute('data-file'),'zh');
      if(ia<0) return 1; if(ib<0) return -1; return ia-ib;
    });
    else arr.sort(function(a,b){ return a.getAttribute('data-file').localeCompare(b.getAttribute('data-file'),'zh'); });
    arr.forEach(function(c){ grid.appendChild(c); });
  }
  // 最近打开徽标（只加一次）
  cards.forEach(function(c){
    if(rec.indexOf(c.getAttribute('data-file'))>=0){
      var b=c.querySelector('.badge');
      if(b) b.insertAdjacentHTML('afterend','<span class="badge recent">最近打开</span>');
    }
  });
  var sortSel=document.getElementById('sort');
  if(sortSel){ sortSel.value='recent'; sortSel.onchange=function(){ sortCards(sortSel.value); }; sortCards('recent'); }

  var filterBox=document.getElementById('filter');
  if(filterBox) filterBox.addEventListener('input',function(){
    var q=filterBox.value.trim().toLowerCase();
    cards.forEach(function(c){
      var hay=(c.querySelector('.ctitle').textContent+' '+c.getAttribute('data-file')).toLowerCase();
      c.style.display=(!q||hay.indexOf(q)>=0)?'':'none';
    });
  });

  var cp=document.getElementById('copypath');
  if(cp) cp.onclick=function(){
    var t=document.getElementById('rootpath').textContent;
    var done=function(){ cp.textContent='已复制'; setTimeout(function(){ cp.textContent='复制路径'; },1500); };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done,function(){ done(); });
    else done();
  };

  /* ── 重名流程图：处理动作（只在电脑上打开时可用）── */
  document.querySelectorAll('[data-act]').forEach(function(btn){
    btn.onclick=function(){
      var op=btn.getAttribute('data-act');
      var payload={op:op};
      if(op==='rename'){
        var to=window.prompt('新文件名（保留 .html 结尾）', btn.getAttribute('data-suggest')||'');
        if(!to) return;
        payload.file=btn.getAttribute('data-file'); payload.to=to.trim();
      } else if(op==='trash'){
        var remove=(btn.getAttribute('data-remove')||'').split('|').filter(Boolean);
        if(!remove.length) return;
        if(!window.confirm('移走这几份？\n\n' + remove.join('\n') + '\n\n（不是删除：连同它们的 SVG / MMD 一起移进回收文件夹，随时可以取回）')) return;
        payload.remove=remove;
      }
      btn.disabled=true; btn.textContent='处理中…';
      fetch('/__flow/act', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)})
        .then(function(r){ return r.json().catch(function(){ return {ok:false, error:'HTTP '+r.status}; }); })
        .then(function(j){
          if(j && j.ok){ location.reload(); }
          else { btn.disabled=false; btn.textContent='重试'; window.alert('处理失败：' + ((j&&j.error)||'未知错误')); }
        })
        .catch(function(e){ btn.disabled=false; btn.textContent='重试'; window.alert('处理失败：'+e.message); });
    };
  });

  /* ── 自检块（?diag=1）── */
  var dl=document.getElementById('diag-list');
  if(dl){
    var imgs=document.querySelectorAll('.card img'), loaded=0, failed=0;
    imgs.forEach(function(i){ if(i.complete&&i.naturalWidth) loaded++; i.addEventListener('load',function(){loaded++;show();}); i.addEventListener('error',function(){failed++;show();}); });
    var keys=[]; try{ for(var i=0;i<localStorage.length;i++) keys.push(localStorage.key(i)); }catch(e){ keys=['(读取失败)']; }
    function show(){
      var m=read().mode;
      dl.innerHTML=
        '<span class="ok">✓ JS 已执行</span>　卡片 '+cards.length+' 张　缩略图 '+loaded+'/'+imgs.length+(failed?('　<span class="bad">失败 '+failed+'</span>'):'')+
        '　主题总设置='+m+'（当前显示 '+(document.documentElement.getAttribute('data-theme'))+'）'+
        '　最近打开 '+recentList().length+' 条'+
        '<br>localStorage：'+(keys.length?keys.join('、'):'（空）')+
        '<br>视口 '+innerWidth+'×'+innerHeight+'　网格列数 '+(grid?getComputedStyle(grid).gridTemplateColumns.split(' ').length:0)+
        '<br>如果你看到上面写着"卡片 3 张"但页面上没有卡片，那是浏览器渲染/缓存问题，请 Ctrl+F5。';
    }
    show();
  }
})();
