import colorsys

def rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def lin(c):
    c /= 255; return c/12.92 if c <= .03928 else ((c+.055)/1.055)**2.4
def L(h):
    r, g, b = rgb(h); return .2126*lin(r)+.7152*lin(g)+.0722*lin(b)
def cr(a, b):
    la, lb = sorted((L(a), L(b)), reverse=True); return (la+.05)/(lb+.05)
def hexs(t): return '#%02x%02x%02x' % tuple(round(max(0, min(255, x))) for x in t)
def mix(a, b, t):  # a over b, alpha t
    return hexs(tuple(x*t+y*(1-t) for x, y in zip(rgb(a), rgb(b))))
def fix(fg, bgs, target, direction):
    """沿明度方向微调，直到对所有背景 >= target；返回新色。"""
    h, l, s = colorsys.rgb_to_hls(*[c/255 for c in rgb(fg)])
    for _ in range(200):
        c = hexs(tuple(x*255 for x in colorsys.hls_to_rgb(h, l, s)))
        if min(cr(c, b) for b in bgs) >= target: return c
        l += -.004 if direction == 'darker' else .004
    return c

themes = {
 'dark':  dict(bg='#12161d', panel='#171d26', p2='#1d242f', p3='#232b37', muted='#9aa5b8', accent='#5aa9ff',
               ok='#46c886', warn='#eab24a', risk='#f4676c', hit='#4a9dff'),
 'light': dict(bg='#e8dbc4', panel='#f7efdf', p2='#f2e8d6', p3='#e2d3b8', muted='#6f6553', accent='#bf6b3a',
               ok='#35935f', warn='#b8801a', risk='#c2403f', hit='#2b7fe0'),
}
print('== 页面 CSS：小字（10.5–12.5px，需要 4.5:1）在三种面板底上的最低对比度 ==')
for name, t in themes.items():
    bgs = [t['panel'], t['p2'], t['p3']]
    for k in ('muted', 'accent', 'ok', 'warn', 'risk'):
        worst = min(cr(t[k], b) for b in bgs)
        flag = 'OK ' if worst >= 4.5 else 'FAIL'
        extra = ''
        if worst < 4.5:
            n = fix(t[k], bgs, 4.5, 'darker' if name == 'light' else 'lighter')
            extra = f'  → 建议 {n}（最低 {min(cr(n,b) for b in bgs):.2f}:1）'
        print(f'{name:5} {k:6} {t[k]}  最低 {worst:5.2f}:1 {flag}{extra}')

print('\n== --hit（app.css 里没有定义）：用作 mark 底色 / 选中行描边 / 序号圆点底 ==')
for name, t in themes.items():
    print(f'{name:5} 白字 on --hit {t["hit"]}: {cr("#ffffff", t["hit"]):.2f}:1   --hit 作描边 on panel2: {cr(t["hit"], t["p2"]):.2f}:1   文字 on mark(30%混合): {cr(t["muted"] if False else ("#eaeef5" if name=="dark" else "#2b2721"), mix(t["hit"], t["p2"], .30)):.2f}:1')

print('\n== 焦点环（非文本，需要 3:1）：accent 相对相邻底色 ==')
for name, t in themes.items():
    print(f'{name:5} accent {t["accent"]}: panel {cr(t["accent"], t["panel"]):.2f}  p2 {cr(t["accent"], t["p2"]):.2f}  bg {cr(t["accent"], t["bg"]):.2f}')

print('\n== SVG：分组带标题字（12px/600，需要 4.5:1），颜色是 flow.mjs 里写死的调色板 ==')
pal = ['#4aa3ff', '#3fbf7f', '#e0a030', '#c084fc', '#ef6b6b', '#2dd4bf']
bands = {'dark': mix('#4aa3ff', '#12161d', .075), 'light': '#e8dbc4'}
for name, bg in (('dark', '#12161d'), ('light', '#e8dbc4')):
    row = []
    for c in pal:
        bgc = mix(c, bg, .075)             # 分组带本身 7.5% 同色填充
        row.append(f'{c}:{cr(c, bgc):.2f}')
    print(name, ' '.join(row))
print('light 下用 filter:brightness(k) 压暗文字后（k 越小越暗）：')
for k in (.7, .6, .55, .5):
    row = []
    for c in pal:
        d = hexs(tuple(x*k for x in rgb(c)))
        row.append(f'{cr(d, mix(c, "#e8dbc4", .075)):.2f}')
    print(f'  k={k}: ' + ' '.join(row) + f'   最低 {min(map(float,row)):.2f}')
print('\n== 触控目标：窄屏页脚按钮实测尺寸（按 CSS 算）==')
print('icon-btn(≤600px): padding 6+6 + svg 14 = 高 ~28px，宽 10+10+14 = 34px；.seg button 6/8 → 高 ~28px；.legend button 4+4+字高 ~14 = 24px 左右')
print('WCAG 2.2 AA 2.5.8 最低 24×24（含间距豁免）；iOS/Android 建议 44/48')
