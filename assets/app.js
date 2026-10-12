(function(){
  'use strict';
  var data=JSON.parse(document.getElementById('flow-data').textContent);
  var meta={}; data.nodes.forEach(function(n){meta[n.id]=n;});
  var statusKeys=[], statusCount={};
  data.nodes.forEach(function(n){ if(!n.status) return; if(!statusCount[n.status]){statusCount[n.status]=0; statusKeys.push(n.status);} statusCount[n.status]++; });
  var hidden={};
  var zoomLabel=document.getElementById('zoom-label');
  // 同一页携带两版布局（竖版/横版）。SVG 的 viewBox 自身会做一次 meet 缩放，
  // 所以每版各自在元素像素空间维护 view{K,TX,TY}，apply 时再反解成 user 单位的 transform。
  var VN=['portrait','landscape'], V={};
  VN.forEach(function(n){
    var s=document.getElementById('flow-svg-'+n);
    if(!s) return;
    var b=s.viewBox.baseVal;
    V[n]={n:n, svg:s, vp:document.getElementById('vp-'+n), vw:b.width, vh:b.height, view:{K:1,TX:0,TY:0}, map:{s:1,cx:0,cy:0}, w:0, h:0};
  });
  var active='portrait', manual=false, sel=null, hits=0, drag=null, lastQuery='', searchHits=null;
  // 触屏与鼠标的"最近一次触摸时间"：必须放在外层 —— window 上的 mouseup/mousemove 也要用它，
  // 放在每个版式的循环里会让循环外的处理器抛 ReferenceError（点节点没反应、drag 清不掉）
  var lastTouch=0;
  function cur(){ return V[active]||V[VN[0]]; }
  function measure(v){ var r=v.svg.getBoundingClientRect(); if(r.width<2||r.height<2) return false; v.w=r.width; v.h=r.height; v.map.s=Math.min(v.w/v.vw, v.h/v.vh); v.map.cx=(v.w-v.vw*v.map.s)/2; v.map.cy=(v.h-v.vh*v.map.s)/2; return true; }
  function paint(v){ var k=v.view.K/v.map.s, tx=(v.view.TX-v.map.cx)/v.map.s, ty=(v.view.TY-v.map.cy)/v.map.s; v.vp.setAttribute('transform','translate('+tx+','+ty+') scale('+k+')');
    // 屏幕上标题只有几像素时自动简化（隐藏小字与底纹、加粗描边），放大回来自动还原
    v.svg.classList.toggle('zoomed-out', v.view.K*15 < 8.5);
  }
  function paintActive(){ var v=cur(); paint(v); zoomLabel.textContent=Math.round(v.view.K/(v.map.s||1)*100)+'%'; }
  function variantKey(v){ return (V.portrait===v)?'portrait':'landscape'; }
  // A1：捏合/滚轮每一帧都会调到这里；直接写 localStorage 在手机上很卡，改成 300ms 防抖 + 关页面前补写一次
  var zoomSaveTimer=null;
  function rememberZoom(v){
    var key='flowviz-zoom:'+SELF+':'+variantKey(v), k=v.view.K;
    if(zoomSaveTimer) clearTimeout(zoomSaveTimer);
    zoomSaveTimer=setTimeout(function(){ zoomSaveTimer=null; lsSet(key, {k:k, ts:Date.now()}); }, 300);
  }
  window.addEventListener('pagehide',function(){ if(zoomSaveTimer){ clearTimeout(zoomSaveTimer); zoomSaveTimer=null; } });
  function fitAll(v){ v=v||cur(); if(!measure(v)) return; v.view.K=v.map.s; v.view.TX=v.map.cx; v.view.TY=v.map.cy; paintActive(); rememberZoom(v); }
  function initial(v){
    v=v||cur(); if(!measure(v)) return;
    var contentAspect=v.vw/v.vh;
    // ?zoom=0.45 固定缩放（截图/检查小比例下的可读性时用），默认仍按下面规则自动选
    var zq=/[?&]zoom=([\d.]+)/.exec(location.search);
    if(zq&&Number(zq[1])>0){ var Kz=v.map.s*Number(zq[1]); v.view.K=Kz; v.view.TX=(v.w-v.vw*Kz)/2; v.view.TY=16; paintActive(); return; }
    // ?fitcap=2.0 可临时改「竖版默认缩放上限」（默认 1.45 = 整幅适配的 1.45 倍）
    var fc=/[?&]fitcap=([\d.]+)/.exec(location.search);
    var fcap=(fc&&Number(fc[1])>0)?Number(fc[1]):1.45;
    var kAll=v.map.s, kWidth=v.w/v.vw*0.99, K;
    // 横而扁的图（分栏后的横版）在窄屏上不要宽度撑满，否则会放大到只看得见一角；直接整幅适配
    if(v.w/v.vw <= v.map.s*1.8 || contentAspect > 1.2){ K=kAll; }
    // 竖版长流程：铺满宽度一屏只能看到四五个环节，所以给个上限（手机上更想先看清整体走向）
    else { K=Math.min(kWidth, kAll*fcap); }
    var zk=lsGet('flowviz-zoom:'+SELF+':'+variantKey(v));   // 上次手动缩放过的档位（换文件各记各的）
    if(zk&&zk.k>0) K=Math.min(kAll*10, Math.max(kAll*0.08, zk.k));
    v.view.K=K;
    v.view.TX=(v.w-v.vw*K)/2;
    v.view.TY=(v.vh*K<=v.h)?(v.h-v.vh*K)/2:16;
    paintActive();
  }
  function zoomAt(v,mx,my,f){ if(!measure(v)) return; var K=Math.min(v.map.s*10, Math.max(v.map.s*0.08, v.view.K*f)); var s=K/v.view.K; v.view.TX=mx-(mx-v.view.TX)*s; v.view.TY=my-(my-v.view.TY)*s; v.view.K=K; paintActive(); rememberZoom(v); }
  function zoomBy(f){ var v=cur(); if(!measure(v)) return; zoomAt(v, v.w/2, v.h/2, f); }
  function autoVariant(){ var w=window.innerWidth, h=window.innerHeight; return (w<760 || w/h<1.08) ? 'portrait' : 'landscape'; }
  function setVariant(name, refit, byUser){
    if(!V[name]) return;
    if(byUser) manual=true;
    active=name;
    document.getElementById('canvas').setAttribute('data-show', name);
    document.querySelectorAll('[data-variant-btn]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-variant-btn')===name); });
    if(refit) initial(); else { measure(cur()); paintActive(); }
  }
  window.addEventListener('resize',function(){
    if(!manual){ var a=autoVariant(); if(a!==active){ setVariant(a,true); return; } }
    initial();
  });
  function touchDist(e){ var a=e.touches[0], b=e.touches[1]; return Math.sqrt((a.clientX-b.clientX)*(a.clientX-b.clientX)+(a.clientY-b.clientY)*(a.clientY-b.clientY)); }
  VN.forEach(function(n){
    var v=V[n]; if(!v) return;
    var pinch=null;
    v.svg.addEventListener('wheel',function(e){ e.preventDefault(); var r=v.svg.getBoundingClientRect(); zoomAt(v, e.clientX-r.left, e.clientY-r.top, e.deltaY<0?1.12:1/1.12); },{passive:false});
    v.svg.addEventListener('mousedown',function(e){
      if(Date.now()-lastTouch<700) return;          // 触屏刚结束：这是浏览器补发的合成事件
      drag={n:n,x:e.clientX,y:e.clientY,ox:v.view.TX,oy:v.view.TY,moved:false};
    });
    v.svg.addEventListener('dblclick',function(e){ if(!(e.target.closest&&e.target.closest('.node'))) fitAll(v); });
    // 触屏：单指平移 / 双指缩放 / 轻点选中（手机上没有鼠标事件，必须单独处理）
    v.svg.addEventListener('touchstart',function(e){
      lastTouch=Date.now();
      if(e.touches.length===1){ pinch=null; drag={n:n,x:e.touches[0].clientX,y:e.touches[0].clientY,ox:v.view.TX,oy:v.view.TY,moved:false}; }
      else if(e.touches.length===2){ drag=null; pinch={d:touchDist(e)}; }
    },{passive:true});
    v.svg.addEventListener('touchmove',function(e){
      if(!e.touches.length){ drag=null; pinch=null; return; }   // 手指都抬了还在收 move？直接结束
      if(e.touches.length===2){
        if(!measure(v)) return;
        var r=v.svg.getBoundingClientRect();
        var d=touchDist(e);
        if(pinch&&pinch.d>0) zoomAt(v, (e.touches[0].clientX+e.touches[1].clientX)/2-r.left, (e.touches[0].clientY+e.touches[1].clientY)/2-r.top, d/pinch.d);
        pinch={d:d}; e.preventDefault(); return;
      }
      if(drag&&drag.n===n&&e.touches.length===1){
        var t=e.touches[0], dx=t.clientX-drag.x, dy=t.clientY-drag.y;
        if(Math.abs(dx)+Math.abs(dy)>6) drag.moved=true;
        v.view.TX=drag.ox+dx; v.view.TY=drag.oy+dy; paintActive(); e.preventDefault();
      }
    },{passive:false});
    v.svg.addEventListener('touchend',function(e){
      lastTouch=Date.now();
      var wasPinch=!!pinch;
      if(drag&&drag.n===n&&!drag.moved&&!wasPinch&&e.changedTouches.length){
        var t=e.changedTouches[0], el=document.elementFromPoint(t.clientX,t.clientY);
        var g=el&&el.closest?el.closest('.node'):null;
        if(g) select(g.getAttribute('data-id')); else select(null);
      }
      if(!e.touches.length){ drag=null; pinch=null; }
      else if(e.touches.length===1){
        // A2：双指缩放时松开一根手指 —— 把拖动重新锚定到剩下的那根，
        // 否则要么拖不动、要么用旧坐标算位移导致画面"跳"一下
        pinch=null;
        drag={n:n,x:e.touches[0].clientX,y:e.touches[0].clientY,ox:v.view.TX,oy:v.view.TY,moved:true};
      }
    });
  });
  // A3：触屏抬手后浏览器会补发一套 mousedown/mouseup，若不忽略，"轻点"会跑两遍（还会顺带起一次拖动）
  window.addEventListener('mousemove',function(e){
    if(!drag) return;
    // 鼠标在动、但没有任何键被按住：
    //   · 已经拖过（moved=true）→ 说明 mouseup 丢了/在窗口外松的手，直接结束拖动（治"黏鼠标"）
    //   · 还没拖过 → 这是一个"点击"的中途，**不能**清 drag，否则随后的 mouseup 选不中节点（点节点没反应）
    if(typeof e.buttons==='number' && e.buttons===0){
      if(drag.moved) drag=null;
      return;
    }
    var v=V[drag.n]; var dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>6) drag.moved=true; v.view.TX=drag.ox+dx; v.view.TY=drag.oy+dy; paintActive(); });
  window.addEventListener('mouseup',function(e){
    // 注意：`drag=null` 必须无条件执行。之前把"触屏后的合成事件"判断写成了提前 return，
    // 结果拖拽状态永远清不掉 —— 表现就是"点一下图以后，图黏在鼠标上跟着走"。
    var synth = Date.now()-lastTouch<700;
    if(!synth && drag&&!drag.moved&&drag.n===active){
      var g=e.target.closest?e.target.closest('.node'):null;
      if(g) select(g.getAttribute('data-id'));
      else if(e.target.closest&&e.target.closest('svg')) select(null);
    }
    drag=null;
  });
  // 拖到窗口外松手 / 切走窗口时也要松开，否则回来还在"黏着"
  window.addEventListener('blur',function(){ drag=null; });
  document.addEventListener('visibilitychange',function(){ if(document.hidden) drag=null; });
  window.addEventListener('pointercancel',function(){ drag=null; });
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function eachSvg(fn){ VN.forEach(function(n){ if(V[n]) fn(V[n].svg, n); }); }
  // 节点键盘可达：给每个 node 加 tabindex/role/aria-label，Enter/空格＝点击选中
  function wireNodeKeyboard(){
    eachSvg(function(s,n){
      s.querySelectorAll('.node').forEach(function(g){
        var m=meta[g.getAttribute('data-id')]||{};
        g.setAttribute('tabindex','0');
        g.setAttribute('role','button');
        g.setAttribute('aria-label', (m.label||m.id||'')+(m.statusLabel?'，'+m.statusLabel:'')+(m.time?'，'+m.time:''));
      });
      s.addEventListener('keydown',function(e){
        var g=e.target.closest?e.target.closest('.node'):null;
        if(g&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); select(g.getAttribute('data-id')); }
      });
    });
  }
  function relayout(){ VN.forEach(function(n){ if(V[n]) measure(V[n]); }); paintActive(); }
  function setPanel(open){ document.body.classList.toggle('panel-open', !!open); relayout(); }
  // C3：右栏画什么只由 sel 决定，统一从这里进（原来是 5 处各自写 renderPanel(null / meta[sel])）
  function refreshPanel(){ renderPanel(sel ? meta[sel] : null); }
  function select(id){
    sel=id;
    if(id) setPanel(true); else if(document.body.classList.contains('panel-open') && window.innerWidth<=600) setPanel(false);
    eachSvg(function(s,n){
      s.querySelectorAll('.node').forEach(function(x){ x.classList.remove('is-sel','is-dim'); });
      s.querySelectorAll('.edge').forEach(function(p){ p.classList.remove('is-hi','is-dim'); p.setAttribute('marker-end','url(#arrow-'+n+')'); });
      s.querySelectorAll('.edge-label-g').forEach(function(p){ p.classList.remove('is-hi','is-dim'); });
    });
    if(!id){ refreshPanel(); return; }
    eachSvg(function(s,n){
      s.querySelectorAll('.node').forEach(function(x){ if(x.getAttribute('data-id')!==id) x.classList.add('is-dim'); });
      var g=s.querySelector('.node[data-id="'+CSS.escape(id)+'"]'); if(g) g.classList.add('is-sel');
      s.querySelectorAll('.edge').forEach(function(p){ var a=p.getAttribute('data-from'),b=p.getAttribute('data-to'); if(a===id||b===id){ p.classList.add('is-hi'); p.setAttribute('marker-end','url(#arrow-hi-'+n+')'); } else p.classList.add('is-dim'); });
      s.querySelectorAll('.edge-label-g').forEach(function(p){ var a=p.getAttribute('data-from'),b=p.getAttribute('data-to'); if(a===id||b===id) p.classList.add('is-hi'); else p.classList.add('is-dim'); });
    });
    refreshPanel();
  }
  function renderOverview(){
    var el=document.getElementById('detail');
    var h='<div class="ov-kicker">流程概览</div>';
    if(searchHits&&searchHits.length){
      h='<div class="hit-head"><span class="sec" style="margin:0">搜索「'+esc(lastQuery)+'」命中 '+searchHits.length+' 处</span>';
      h+='<span class="hit-nav"><button data-hit-nav="-1" title="上一个（↑ / Shift+Enter）">↑</button>';
      h+='<span class="hit-pos">'+(hitIdx+1)+'/'+searchHits.length+'</span>';
      h+='<button data-hit-nav="1" title="下一个（↓ / Enter）">↓</button></span></div>';
      h+='<div class="hit-tip only-pc">键盘 ↑ ↓（或 Enter / Shift+Enter）连着翻命中，Esc 清空</div>';
      h+='<div class="hits">'+searchHits.map(hitRow).join('')+'</div>';
      h+='<label class="focus-toggle"><input type="checkbox" id="focus-on"'+(focusOn?' checked':'')+'> 自动聚焦命中</label>';
      h+='<div class="sec">流程概览</div>';
    }
    h+='<h2 class="ov-title">'+esc(data.title||'未命名流程')+'</h2>';
    if(data.subtitle) h+='<p class="ov-sub">'+esc(data.subtitle)+'</p>';
    h+='<div class="stats"><div class="stat"><b>'+data.nodes.length+'</b><span>环节</span></div><div class="stat"><b>'+data.edges.length+'</b><span>连接</span></div><div class="stat"><b>'+data.groups.length+'</b><span>分组</span></div></div>';
    if(statusKeys.length){
      h+='<div class="sec">按状态筛选</div><div class="pillcol">';
      statusKeys.forEach(function(s){ h+='<button class="ov-status'+(hidden[s]?' off':'')+'" data-status="'+s+'"><i class="dot st-'+s+'"></i><span>'+esc(labelOf(s))+'</span><em>'+statusCount[s]+'</em></button>'; });
      h+='</div>';
    }
    var focus=data.nodes.filter(function(n){ return n.status==='risk'||n.status==='hold'; });
    if(focus.length){
      h+='<div class="sec">需关注（点击定位）</div>';
      focus.forEach(function(n){ h+='<button class="ov-focus" data-goto="'+esc(n.id)+'"><span class="of-dot st-'+esc(n.status)+'"></span><span class="of-label">'+esc(n.label)+'</span><em>'+esc(n.statusLabel)+'</em></button>'; });
    }
    h+='<div class="sec">图例</div><div class="klegend">'+data.kinds.map(function(k){ return '<span class="kchip k-'+k.key+'">'+esc(k.label)+'</span>'; }).join('')+'</div>';
    h+='<p class="hint"><span class="only-pc">点节点看详情 · 滚轮缩放 · 拖拽平移 · 双击空白适配 · 搜索后 ↑↓ 翻命中 · Esc 取消选中</span><span class="only-touch">点环节看详情 · 单指拖动 · 双指缩放 · 底部按钮可切竖/横版</span></p>';
    el.innerHTML=h;
    el.querySelectorAll('.ov-status').forEach(function(b){ b.onclick=function(){ toggleStatus(b.getAttribute('data-status')); }; });
    el.querySelectorAll('[data-goto]').forEach(function(b){ b.onclick=function(){ select(b.getAttribute('data-goto')); }; });
    el.querySelectorAll('[data-hit]').forEach(function(b){ b.onclick=function(){ hitIdx=Number(b.getAttribute('data-hit'))||0; focusHits(); renderPanel(null); }; });
    el.querySelectorAll('[data-hit-nav]').forEach(function(b){ b.onclick=function(){ jumpHit(Number(b.getAttribute('data-hit-nav'))); }; });
    var fo=document.getElementById('focus-on');
    if(fo) fo.onchange=function(){ focusOn=fo.checked; if(focusOn) focusHits(); };
  }
  function labelOf(s){ return data.statusLabels[s]||s; }
  function renderPanel(n){
    var el=document.getElementById('detail');
    if(!n){ renderOverview(); return; }
    var h='<button class="back" id="panel-back">← 返回概览</button>';
    h+='<div class="d-id">'+esc(n.id)+'</div>';
    h+='<h2 class="d-title">'+esc(n.label)+'</h2>';
    h+='<div class="chips"><span class="chip k-'+esc(n.kind)+'">'+esc(n.kindLabel||n.kind)+'</span>';
    if(n.status) h+='<span class="chip st-'+esc(n.status)+'"><i class="dot st-'+esc(n.status)+'"></i>'+esc(n.statusLabel||n.status)+'</span>';
    h+='</div>';
    if(n.time) h+='<div class="kv"><b>时间</b><span>'+esc(n.time)+'</span></div>';
    if(n.owner) h+='<div class="kv"><b>负责</b><span>'+esc(n.owner)+'</span></div>';
    if(n.detail) h+='<div class="kv"><b>说明</b><span>'+esc(n.detail).replace(/\n/g,'<br>')+'</span></div>';
    if(n.note) h+='<div class="kv note"><b>注意</b><span>'+esc(n.note).replace(/\n/g,'<br>')+'</span></div>';
    h+='<div class="kv"><b>上游</b><span>'+(n.preds.length?n.preds.map(linkOf).join(' '):'—')+'</span></div>';
    h+='<div class="kv"><b>下游</b><span>'+(n.succs.length?n.succs.map(linkOf).join(' '):'—')+'</span></div>';
    el.innerHTML=h;
    var b=document.getElementById('panel-back'); if(b) b.onclick=function(){ select(null); };
    el.querySelectorAll('[data-goto]').forEach(function(x){ x.onclick=function(){ select(x.getAttribute('data-goto')); }; });
  }
  function linkOf(id){ var n=meta[id]; var t=n?n.label:id; return '<button class="jump" data-goto="'+esc(id)+'" title="'+esc(id)+'">'+esc(t)+'</button>'; }
  function toggleStatus(s){ if(hidden[s]){ delete hidden[s]; } else { hidden[s]=1; } applyFilter(); }
  function applyFilter(){
    eachSvg(function(s){ s.setAttribute('data-hide-status', Object.keys(hidden).join(' ')); });
    document.querySelectorAll('.legend button').forEach(function(b){ if(hidden[b.getAttribute('data-status')]) b.classList.add('off'); else b.classList.remove('off'); });
    if(!sel) renderOverview();
  }
  document.querySelectorAll('.legend button').forEach(function(b){ b.onclick=function(){ toggleStatus(b.getAttribute('data-status')); }; });
  document.querySelectorAll('[data-variant-btn]').forEach(function(b){ b.onclick=function(){ setVariant(b.getAttribute('data-variant-btn'), true, true); }; });
  document.getElementById('zoom-in').onclick=function(){ zoomBy(1.2); };
  document.getElementById('zoom-out').onclick=function(){ zoomBy(1/1.2); };
  document.getElementById('zoom-fit').onclick=function(){ fitAll(); };
  var panelBtn=document.getElementById('panel-toggle');
  if(panelBtn) panelBtn.onclick=function(){ var open=!document.body.classList.contains('panel-open'); setPanel(open); if(open) renderPanel(sel ? meta[sel] : null); };
  var hitIdx=0, focusOn=true;
  document.getElementById('search').addEventListener('input',function(e){
    var q=e.target.value.trim().toLowerCase(); lastQuery=q; hits=0; hitIdx=0;
    var shownSet={}, softSet={}, order=[];
    eachSvg(function(s){
      s.classList.toggle('searching', !!q);
      s.querySelectorAll('.node').forEach(function(g){
        var n=meta[g.getAttribute('data-id')]||{};
        g.classList.remove('is-hit','is-hit-soft');
        if(!q) return;
        var shown=[n.label,n.id,n.time,n.owner].join(' ').toLowerCase();
        var rest=[n.detail,n.note].join(' ').toLowerCase();
        if(shown.indexOf(q)>=0){ g.classList.add('is-hit'); if(!shownSet[n.id]){ shownSet[n.id]=1; order.push(n.id); } }
        else if(rest.indexOf(q)>=0){ g.classList.add('is-hit-soft'); if(!shownSet[n.id]&&!softSet[n.id]){ softSet[n.id]=1; order.push(n.id); } }
      });
    });
    hits=order.length;
    searchHits=q?order:null;
    var softOnly=Object.keys(softSet).filter(function(id){ return !shownSet[id]; }).length;
    document.getElementById('search-count').textContent=q?(hits+' 个匹配'+(softOnly?'（'+softOnly+' 个只在说明/备注里）':'')):'';
    // 手机端结果清单默认藏在收起的抽屉里，搜到东西就自动弹出来（这是'搜了等于没提示'的根因）
    if(q&&hits>0&&!sel) setPanel(true);
    if(!sel) refreshPanel();
    if(q&&hits>0&&focusOn) focusHits();
  });
  // 节点在画布(user)坐标系里的矩形。注意 getBBox() 返回的是节点自身局部坐标（0,0~w,h），
  // 必须再加上该 <g> 的 translate(x,y)，否则聚焦会跳到画布左上角附近（踩过）。
  function nodeBox(g){
    var bb=g.getBBox();
    var m=/translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(g.getAttribute('transform')||'');
    var tx=m?parseFloat(m[1]):0, ty=m?parseFloat(m[2]):0;
    return {x:tx+bb.x, y:ty+bb.y, w:bb.width, h:bb.height};
  }
  function hitBox(ids){
    var svg=cur().svg, x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    ids.forEach(function(id){ var g=svg.querySelector('.node[data-id="'+CSS.escape(id)+'"]'); if(!g) return;
      var b=nodeBox(g); x0=Math.min(x0,b.x); y0=Math.min(y0,b.y); x1=Math.max(x1,b.x+b.w); y1=Math.max(y1,b.y+b.h); });
    return isFinite(x0)?{x0:x0,y0:y0,x1:x1,y1:y1}:null;
  }
  function animateVp(){ var v=cur(); v.vp.classList.add('vp-anim'); clearTimeout(v._animT); v._animT=setTimeout(function(){ v.vp.classList.remove('vp-anim'); },320); }
  function centerOn(id,scale){
    var v=cur(); if(!measure(v)) return;
    var g=v.svg.querySelector('.node[data-id="'+CSS.escape(id)+'"]'); if(!g) return;
    var b=nodeBox(g); var K=(scale||v.view.K);
    animateVp();
    v.view.K=K;
    v.view.TX=v.w/2-((b.x+b.w/2)*K);
    v.view.TY=v.h/2-((b.y+b.h/2)*K);
    paintActive();
  }
  function focusHits(){
    if(!searchHits||!searchHits.length) return;
    var v=cur(); if(!measure(v)) return;
    var box=hitBox(searchHits); if(!box) return;
    var bw=box.x1-box.x0, bh=box.y1-box.y0;
    var pad=90;
    var kFit=Math.min((v.w-pad*2)/Math.max(bw,1), (v.h-pad*2)/Math.max(bh,1));
    // 命中离得太远时不要为了'全都装下'把字缩没：低于当前 60% 就只居中到当前命中
    if(searchHits.length===1 || kFit>=v.view.K*0.6){
      var K=Math.min(kFit, v.view.K*2.2);
      animateVp();
      v.view.K=K;
      v.view.TX=v.w/2-((box.x0+bw/2)*K);
      v.view.TY=v.h/2-((box.y0+bh/2)*K);
      paintActive();
    } else {
      centerOn(searchHits[hitIdx]||searchHits[0], v.view.K);
    }
  }
  function jumpHit(d){
    if(!searchHits||!searchHits.length) return;
    hitIdx=(hitIdx+d+searchHits.length)%searchHits.length;
    focusHits();
    centerOn(searchHits[hitIdx], cur().view.K);
    if(!sel) refreshPanel();
    else select(searchHits[hitIdx]);
    var row=document.querySelector('.hit-row.cur');
    if(row&&row.scrollIntoView) row.scrollIntoView({block:'nearest'});
  }
  document.getElementById('search').addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'){ e.preventDefault(); jumpHit(1); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); jumpHit(-1); }
    else if(e.key==='Enter'){ e.preventDefault(); jumpHit(e.shiftKey?-1:1); }
    else if(e.key==='Escape'){ e.target.value=''; e.target.dispatchEvent(new Event('input')); e.target.blur(); }
  });
  function mark(text,q){ var i=String(text).toLowerCase().indexOf(q); if(i<0) return esc(text); return esc(String(text).slice(0,i))+'<mark>'+esc(String(text).slice(i,i+q.length))+'</mark>'+esc(String(text).slice(i+q.length)); }
  function hitRow(id,i){
    var n=meta[id]||{}, q=lastQuery;
    var fields=[['标题',n.label],['id',n.id],['时间',n.time],['负责',n.owner],['说明',n.detail],['注意',n.note]];
    var field='标题', text=n.label||'', soft=false;
    for(var k=0;k<fields.length;k++){
      var v=fields[k][1]||'';
      if(String(v).toLowerCase().indexOf(q)>=0){ field=fields[k][0]; text=v; soft=(field==='说明'||field==='注意'); break; }
    }
    var idx=String(text).toLowerCase().indexOf(q);
    var snip=(idx>26?'…':'')+String(text).slice(Math.max(0,idx-22), Math.max(0,idx-22)+54);
    return '<button class="hit-row'+(soft?' soft':'')+(i===hitIdx?' cur':'')+'" data-hit="'+i+'"><span class="hr-n">'+(i+1)+'</span>'
      +'<span class="hr-main"><span class="hr-label">'+esc(n.label||id)+'<em>'+field+'</em></span>'
      +'<span class="hr-snip">'+mark(snip,q)+'</span></span></button>';
  }
  /* ── 全部流程图抽屉 ── */
  var flows=(data.flows||[]).slice(), selfFile=data.selfFile||'';
  function renderFlows(){
    var el=document.getElementById('flows-list');
    if(!flows.length){ el.innerHTML='<p class="hint">同目录下还没找到其它由本 skill 生成的流程图。</p>'; return; }
    el.innerHTML=flows.map(function(f){
      var cur=(f.file===selfFile);
      // 当前页不是链接：误点也不会原地不动，让人以为坏了
      if(cur) return '<div class="flow-row cur"><span class="fr-name">'+esc(f.title||f.file)+'<span class="fr-cur">当前</span></span>'
        +'<span class="fr-meta">'+f.nodes+' 环节 · '+f.edges+' 连接 · '+esc(f.mtime||'')+'</span></div>';
      return '<a class="flow-row" href="'+encodeURI(f.file)+'"><span class="fr-name">'+esc(f.title||f.file)+'</span>'
        +'<span class="fr-meta">'+f.nodes+' 环节 · '+f.edges+' 连接 · '+esc(f.mtime||'')+'</span></a>';
    }).join('');
  }
  function openFlows(open){
    var dr=document.getElementById('flows-drawer');
    dr.classList.toggle('open', !!open);
    dr.setAttribute('aria-hidden', open?'false':'true');
    // inert 立刻生效（visibility 的过渡延迟会让"打开即聚焦"失效），关闭时整棵子树不可 Tab / 不可点
    if('inert' in dr) dr.inert = !open;
    document.getElementById('flows-toggle').setAttribute('aria-expanded', open?'true':'false');
    document.getElementById('drawer-scrim').classList.toggle('open', !!open);
    if(open){ renderFlows(); refreshFlows(); document.getElementById('flows-close').focus(); }
    else if(document.activeElement&&dr.contains(document.activeElement)) document.getElementById('flows-toggle').focus();
  }
  function refreshFlows(){
    if(location.protocol.indexOf('http')!==0) return;
    fetch('流程索引.json?t='+Date.now()).then(function(r){ return r.ok?r.json():null; }).then(function(j){
      if(j&&j.flows&&j.flows.length){ flows=j.flows; renderFlows(); }
    }).catch(function(){});
  }
  document.getElementById('flows-toggle').onclick=function(){ openFlows(true); };
  document.getElementById('flows-close').onclick=function(){ openFlows(false); };
  document.getElementById('drawer-scrim').onclick=function(){ openFlows(false); };
  function download(name,blob){ var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500); }
  function variantTag(){ return active==='portrait' ? '-竖版' : '-横版'; }
  function svgSource(){
    var v=cur(); var c=v.svg.cloneNode(true);
    c.setAttribute('xmlns','http://www.w3.org/2000/svg'); c.removeAttribute('id');
    // 导出件不带交互用的无障碍属性，保持与以前一致
    c.querySelectorAll('[tabindex],[role],[aria-label]').forEach(function(x){ x.removeAttribute('tabindex'); x.removeAttribute('role'); x.removeAttribute('aria-label'); });
    return '<?xml version="1.0" encoding="UTF-8"?>\n'+c.outerHTML;
  }
  document.getElementById('export-svg').onclick=function(){ download(data.slug+variantTag()+'.svg', new Blob([svgSource()],{type:'image/svg+xml'})); };
  document.getElementById('export-png').onclick=function(){
    var v=cur(); var src=svgSource(); var img=new Image(); var scale=2;
    img.onload=function(){ var cv=document.createElement('canvas'); cv.width=v.vw*scale; cv.height=v.vh*scale; var cx=cv.getContext('2d'); cx.fillStyle=(document.documentElement.getAttribute('data-theme')==='light')?'#edf1f7':'#0e1116'; cx.fillRect(0,0,cv.width,cv.height); cx.drawImage(img,0,0,cv.width,cv.height); cv.toBlob(function(b){ if(b) download(data.slug+variantTag()+'.png',b); }); };
    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(src);
  };
  var THEME_KEY='flowviz-theme', SELF=data.selfFile||decodeURIComponent(location.pathname.split('/').pop());
  function lsGet(k){ try{ var v=localStorage.getItem(k); if(!v) return null; try{ return JSON.parse(v); }catch(e){ return {mode:v,ts:0}; } }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function globalPref(){ return lsGet(THEME_KEY)||{mode:'system',ts:0}; }
  function selfPref(){ return lsGet(THEME_KEY+':'+SELF); }
  function lockPref(){ return lsGet('flowviz-lock:'+SELF); }
  function systemTheme(){ return (window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'; }
  function effective(){
    var lock=lockPref(); if(lock&&lock.locked) return {mode:lock.mode, src:'locked'};
    var g=globalPref(), p=selfPref();
    if(p&&p.ts>(g.ts||0)) return {mode:p.mode, src:'self'};
    return {mode:g.mode||'system', src:'global'};
  }
  var toastTimer=null;
  function toast(msg){
    var el=document.getElementById('toast'); if(!el) return;
    el.textContent=msg; el.classList.add('show');
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(function(){ el.classList.remove('show'); },2800);
  }
  function modeLabel(e){ return e.src==='locked' ? '已锁定' : (e.mode==='system'?'跟随系统':(e.mode==='dark'?'深色':'浅色')) + (e.src==='self'?'（这张图单独设的）':'（跟着首页「外观」设置）'); }
  function applyTheme(){
    var e=effective(); var d=(e.mode==='system')?systemTheme():e.mode;
    document.documentElement.setAttribute('data-theme',d);
    eachSvg(function(s){ s.setAttribute('data-theme',d); });
    var locked=(e.src==='locked');
    var lb=document.getElementById('lock');
    if(lb){ lb.classList.toggle('on',locked); lb.title=locked?'这张图的颜色已锁定，点一下解锁':'锁定这张图的颜色（锁定后首页「外观」改不动它）';
      var sp=lb.querySelector('span'); if(sp) sp.textContent=locked?'已锁定':'锁定颜色'; }
    var b=document.getElementById('theme');
    if(b){ b.classList.toggle('locked',locked); b.title=locked?'颜色已锁定：先点「锁定颜色」解锁，才能改':('当前：'+modeLabel(e)+'　点一下在这张图上切明/暗'); }
  }
  document.getElementById('theme').onclick=function(){
    var e=effective();
    if(e.src==='locked'){ toast('这张图的颜色已锁定，先点「锁定颜色」解锁'); return; }
    var next=(document.documentElement.getAttribute('data-theme')==='light')?'dark':'light';
    lsSet(THEME_KEY+':'+SELF,{mode:next,ts:Date.now()});
    applyTheme();
    toast('这张图已设为'+(next==='light'?'浅色':'深色')+'（后改的优先；改首页「显示设置」会再覆盖它）');
  };
  // 本地文件模式（双击打开）下浏览器只给纯文件名目录列表，所以指向生成的静态首页
  var homeBtn=document.getElementById('home-btn');
  if(homeBtn && location.protocol==='file:') homeBtn.setAttribute('href','./index.html');
  var lockBtn=document.getElementById('lock');
  if(lockBtn) lockBtn.onclick=function(){
    var lock=lockPref();
    if(lock&&lock.locked){ lsDel('flowviz-lock:'+SELF); toast('已解锁：这张图重新跟着首页「外观」走'); }
    else { var cur=document.documentElement.getAttribute('data-theme'); lsSet('flowviz-lock:'+SELF,{locked:true,mode:cur,ts:Date.now()}); toast('已锁定当前颜色：改总设置或别处的颜色都不会影响这张图'); }
    applyTheme();
  };
  if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').addEventListener){
    matchMedia('(prefers-color-scheme: light)').addEventListener('change',function(){ applyTheme(); });
  }
  applyTheme();
  // C2：首页/别的标签页改了外观设置 → 这个标签页立刻跟着变（localStorage 的 storage 事件只在别的标签页触发）
  window.addEventListener('storage',function(e){ if(!e.key||e.key.indexOf('flowviz-')===0) applyTheme(); });
  document.getElementById('mmd-toggle').onclick=function(){ document.getElementById('mmd-panel').classList.toggle('open'); };
  document.getElementById('mmd-copy').onclick=function(){ var t=document.getElementById('mmd-src'); t.select(); var b=this; try{ document.execCommand('copy'); b.textContent='已复制'; }catch(err){ b.textContent='请手动复制'; } setTimeout(function(){ b.textContent='复制'; },1500); };
  window.addEventListener('keydown',function(e){
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
    // 搜索出结果后，焦点不在输入框里（比如刚点过某条命中）也能用 ↑↓ 连续翻看
    if((e.key==='ArrowDown'||e.key==='ArrowUp')&&searchHits&&searchHits.length){ e.preventDefault(); jumpHit(e.key==='ArrowDown'?1:-1); return; }
    if(e.key==='+'||e.key==='='){ zoomBy(1.2); }
    if(e.key==='-'){ zoomBy(1/1.2); }
    if(e.key==='0'){ fitAll(); }
    if(e.key==='Escape'){
      var dr=document.getElementById('flows-drawer');
      if(dr.classList.contains('open')){ openFlows(false); return; }
      if(document.getElementById('mmd-panel').classList.contains('open')){ document.getElementById('mmd-panel').classList.remove('open'); return; }
      select(null);
    }
  });
  // 抽屉首屏就是关闭态：立刻 inert，免得 Tab 一上来就钻进屏外的链接
  (function(){ var dr=document.getElementById('flows-drawer'); if(dr&&('inert' in dr)) dr.inert=true; })();
  // B4：把"开关态"同步成 aria-pressed，读屏才念得出当前选中的版式 / 筛选项 / 是否锁定
  function syncAria(){
    document.querySelectorAll('[data-variant-btn]').forEach(function(b){
      b.setAttribute('aria-pressed', b.classList.contains('on')?'true':'false');
    });
    document.querySelectorAll('.legend button[data-status]').forEach(function(b){
      b.setAttribute('aria-pressed', b.classList.contains('off')?'false':'true');
    });
    var lk=document.getElementById('lock-btn');
    if(lk) lk.setAttribute('aria-pressed', lk.classList.contains('on')?'true':'false');
  }
  document.addEventListener('click',function(){ setTimeout(syncAria,0); });
  syncAria();
  wireNodeKeyboard();
  setVariant(autoVariant(), true);
  refreshPanel();
})();