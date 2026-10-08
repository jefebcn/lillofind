// Iniettato nella pagina dallo smoke test: elenca i testi visibili sotto il contrasto
// WCAG AA (4.5:1 sotto i 18px, 3:1 per testo grande). Ritorna un array.
(()=>{
const parse=c=>{const m=c.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};
const lum=({r,g,b})=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(r)+.7152*f(g)+.0722*f(b)};
const blend=(top,bot)=>({r:top.r*top.a+bot.r*(1-top.a),g:top.g*top.a+bot.g*(1-top.a),b:top.b*top.a+bot.b*(1-top.a),a:1});
function bgOf(el){const stack=[];let e=el;while(e&&e.nodeType===1){const cs=getComputedStyle(e);if(cs.backgroundImage&&cs.backgroundImage!=='none')return null;/* immagine: salta */
  const c=parse(cs.backgroundColor);if(c&&c.a>0){stack.push(c);if(c.a>=1)break;}e=e.parentElement;}
  let bg={r:255,g:255,b:255,a:1};for(let i=stack.length-1;i>=0;i--)bg=blend(stack[i],bg);return bg;}
const out=[];const seen=new Set();
const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
while(n=w.nextNode()){const t=n.textContent.trim();if(!t||t.length<2||!/[\p{L}\p{N}]/u.test(t))continue;const el=n.parentElement;if(!el||seen.has(el))continue;seen.add(el);
  const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||+cs.opacity===0)continue;
  let o=el,hid=false;while(o){const c=getComputedStyle(o);if(c.display==='none'||+c.opacity<.1){hid=true;break;}o=o.parentElement;}if(hid)continue;
  const fg=parse(cs.color);const bg=bgOf(el);if(!fg||!bg)continue;const f=blend(fg,bg);
  const L1=lum(f),L2=lum(bg);const ratio=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
  const px=parseFloat(cs.fontSize),bold=+cs.fontWeight>=700;const large=px>=18||(px>=14&&bold);
  const min=large?3:4.5;if(ratio<min)out.push({t:t.slice(0,40),ratio:+ratio.toFixed(2),px,color:cs.color,id:el.id||'',cls:(el.className||'').toString().slice(0,30)});
}
return out;})()
